sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast",
  "sap/m/MessageBox",
  "sap/ui/core/Fragment",
  "sap/ui/core/format/DateFormat"
], function (Controller, Filter, FilterOperator, JSONModel, MessageToast, MessageBox, Fragment, DateFormat) {
  "use strict";

  return Controller.extend("lmsui5.controller.Employee", {

    onInit: function () {
      if (!this.getOwnerComponent().getModel("user")) {
        this.getOwnerComponent().setModel(new JSONModel({}), "user");
      }

      this.getView().setModel(new JSONModel(this._buildApplyLeaveModelData()), "applyLeave");

      this.getView().setModel(new JSONModel({
        requests: [],
        counts: { total: 0, pending: 0, approved: 0, rejected: 0 }
      }), "leaveRequests");

      // ✅ CHANGED: Track which request IDs we've already alerted on, so we
      // don't re-show the rejection popup on every refresh
      this._alreadyNotifiedIds = new Set();

      const oRouter = this.getOwnerComponent().getRouter();
      oRouter.getRoute("Employee").attachPatternMatched(this._onRouteMatched, this);

      this.getView().addEventDelegate({
        onAfterShow: function () {
          this._applyEmployeeFilter();
          this._refreshOwnLeaveData();
        }.bind(this)
      });

      // Subscribe to leave changes published by Manager
      this._bus = sap.ui.getCore().getEventBus();
      this._bus.subscribe("leave", "changed", this._onLeaveChanged, this);
    },

    onExit: function () {
      if (this._pApplyLeaveDlg) {
        this._pApplyLeaveDlg.then(function (oDialog) { oDialog.destroy(); });
        this._pApplyLeaveDlg = null;
      }
      if (this._pRequestDetailsDlg) {
        this._pRequestDetailsDlg.then(function (oDialog) { oDialog.destroy(); });
        this._pRequestDetailsDlg = null;
      }
      if (this._pManagerMsgDlg) {
        this._pManagerMsgDlg.then(function (oDialog) { oDialog.destroy(); });
        this._pManagerMsgDlg = null;
      }
      if (this._bus) {
        this._bus.unsubscribe("leave", "changed", this._onLeaveChanged, this);
      }
    },

    getEmployeeData: async function (sUsername) {
      const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailPattern.test(sUsername)) {
        this._showError("Please enter a valid email address.");
        return;
      }

      const msgStrip = this.byId("msg");
      if (msgStrip) msgStrip.setVisible(false);

      try {
        const res = await fetch("/odata/v4/my-services/getEmployeeData", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: sUsername })
        });

        if (!res.ok) {
          const resClone = res.clone();
          let errTxt = "Failed to fetch employee data";
          try { errTxt = (await res.json())?.error?.message || errTxt; }
          catch { try { errTxt = await resClone.text(); } catch {} }
          throw new Error(errTxt);
        }

        const data = await res.json();

        const oUserModel = this.getOwnerComponent().getModel("user");
        if (oUserModel && data.employee) {
          oUserModel.setProperty("/id", data.employee.id);
          oUserModel.setProperty("/employeeId", data.employee.employeeID);
          oUserModel.setProperty("/firstName", data.employee.firstName);
          oUserModel.setProperty("/lastName", data.employee.lastName);
          oUserModel.setProperty("/email", data.employee.email);
          oUserModel.setProperty("/department", data.employee.department);
          oUserModel.setProperty("/managerId", data.employee.managerID);

          const fullName = `${data.employee.firstName || ""} ${data.employee.lastName || ""}`.trim();
          oUserModel.setProperty("/fullName", fullName);

          if (Array.isArray(data.leaveBalances)) {
            oUserModel.setProperty("/leaveBalances", data.leaveBalances);
          }
        }

        MessageToast.show("Employee data loaded successfully");
        this._applyEmployeeFilter();
        this._loadMyLeaveRequests();

      } catch (err) {
        this._showError(err.message || "Failed to load employee data");
        console.error("API Error:", err);
      }
    },

    _showError: function (sMessage) {
      MessageToast.show(sMessage, { duration: 3000 });
    },

    _onRouteMatched: function (oEvent) {
      const oArgs = oEvent.getParameter("arguments");
      const sUsername = oArgs.username;

      const authModel = this.getOwnerComponent().getModel("auth");
      if (authModel && sUsername) {
        authModel.setProperty("/username", sUsername);
      }

      if (sUsername) {
        // ✅ CHANGED: Reset notification tracking on fresh route match (new session)
        this._alreadyNotifiedIds = new Set();
        this.getEmployeeData(sUsername);
      }
    },

    _applyEmployeeFilter: function () {
      const oUserModel = this.getOwnerComponent().getModel("user");
      const sEmpId = oUserModel && oUserModel.getProperty("/employeeId");
      const oBinding = this.byId("balancesTable")?.getBinding("items");
      if (!oBinding) return;

      if (sEmpId) {
        oBinding.filter([new Filter("employee/employeeId", FilterOperator.EQ, sEmpId)]);
      } else {
        oBinding.filter([]);
      }
    },

    onSearch: function (oEvent) {
      const sQuery = oEvent.getParameter("query");
      this._applySearchFilter(sQuery);
    },

    onLiveChange: function (oEvent) {
      const sQuery = oEvent.getParameter("newValue");
      this._applySearchFilter(sQuery);
    },

    _applySearchFilter: function (sQuery) {
      const oBinding = this.byId("balancesTable")?.getBinding("items");
      if (!oBinding) return;

      const aFilters = [];
      const oUserModel = this.getOwnerComponent().getModel("user");
      const sEmpId = oUserModel && oUserModel.getProperty("/employeeId");
      if (sEmpId) {
        aFilters.push(new Filter("employee/employeeId", FilterOperator.EQ, sEmpId));
      }
      if (sQuery) {
        aFilters.push(new Filter({
          filters: [
            new Filter("leaveType/code", FilterOperator.Contains, sQuery),
            new Filter("leaveType/description", FilterOperator.Contains, sQuery)
          ],
          and: false
        }));
      }
      oBinding.filter(aFilters);
    },

    onClear: function () {
      const oSF = this.byId("sf");
      oSF && oSF.setValue("");
      this._applySearchFilter("");
    },

    onRefresh: function () {
      const oBinding = this.byId("balancesTable")?.getBinding("items");
      if (oBinding) {
        oBinding.refresh();
        MessageToast.show("Data refreshed");
      }
      this._loadMyLeaveRequests();
    },

    onLogout: function () {
      sap.m.MessageBox.confirm("Are you sure you want to logout?", {
        actions: [sap.m.MessageBox.Action.OK, sap.m.MessageBox.Action.CANCEL],
        emphasizedAction: sap.m.MessageBox.Action.OK,
        onClose: (sAction) => {
          if (sAction !== sap.m.MessageBox.Action.OK) return;
          try { sessionStorage.clear(); } catch (e) {}
          try { localStorage.clear(); } catch (e) {}
          if (sap.ushell?.Container) {
            window.location.hash = "#Shell-home";
            return;
          }
          const oComp = this.getOwnerComponent?.();
          const oRouter = oComp?.getRouter?.();
          if (oRouter?.navTo) {
            oRouter.navTo("Login", {}, true);
            return;
          }
          window.location.replace("/login");
        }
      });
    },

    formatBalanceState: function (v) {
      const n = Number(v);
      if (isNaN(n)) return "None";
      if (n < 0) return "Error";
      if (n === 0) return "Warning";
      return "Success";
    },

    formatStatusState: function (s) {
      switch ((s || "").toLowerCase()) {
        case "pending": return "Warning";
        case "approved": return "Success";
        case "rejected": return "Error";
        case "cancelled": return "None";
        default: return "None";
      }
    },

    formatDateRange: function (sStart, sEnd) {
      if (!sStart && !sEnd) return "";
      try {
        const fmt = DateFormat.getDateInstance({ style: "medium" });
        const a = sStart ? fmt.format(new Date(sStart)) : "";
        const b = sEnd ? fmt.format(new Date(sEnd)) : "";
        return a && b ? `${a} → ${b}` : (a || b);
      } catch (e) {
        return `${sStart || ""} → ${sEnd || ""}`;
      }
    },

    formatDateTime: function (sDateTime) {
      if (!sDateTime) return "";
      try {
        const fmt = DateFormat.getDateTimeInstance({ style: "medium" });
        return fmt.format(new Date(sDateTime));
      } catch (e) {
        return sDateTime;
      }
    },

    _loadMyLeaveRequests: async function () {
      const oUserModel = this.getOwnerComponent().getModel("user");
      const sEmployeeId = oUserModel?.getProperty("/employeeId");
      if (!sEmployeeId) return;

      try {
        const res = await fetch("/odata/v4/my-services/leaveRequests", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ employeeID: sEmployeeId })
        });

        if (!res.ok) throw new Error("Failed to load leave requests");

        const data = await res.json();
        const requests = data.requests || [];

        const counts = {
          total: requests.length,
          pending: requests.filter(r => r.status === "Pending").length,
          approved: requests.filter(r => r.status === "Approved").length,
          rejected: requests.filter(r => r.status === "Rejected").length
        };

        const oRequestsModel = this.getView().getModel("leaveRequests");
        oRequestsModel.setProperty("/requests", requests);
        oRequestsModel.setProperty("/counts", counts);

        return requests; // ✅ CHANGED: return requests so callers can use them
      } catch (err) {
        console.error("Failed to load leave requests:", err);
        return [];
      }
    },

    /**
     * ✅ CHANGED: Only show notification for requests not yet notified.
     * Accepts optional `sChangeType` ("approved" | "rejected") to show targeted message.
     */
  _checkForRejectionNotifications: function (requests, sTargetRequestId) {
  let newRejections;

  if (sTargetRequestId) {
    // Manager just rejected a specific request — find only that one
    // Don't filter on _alreadyNotifiedIds here because this IS a fresh rejection
    newRejections = requests.filter(r =>
      r.id === sTargetRequestId &&
      r.status === "Rejected"
    );
  } else {
    // Fallback (bulk reject without specific ID): find all unseen rejections
    newRejections = requests.filter(r =>
      r.status === "Rejected" &&
      r.managerComments &&
      r.id &&
      !this._alreadyNotifiedIds.has(r.id)
    );
  }

  if (newRejections.length === 0) return;

  // Mark as notified to prevent re-showing on subsequent refreshes
  newRejections.forEach(r => this._alreadyNotifiedIds.add(r.id));

  const rejection = newRejections[0];
  const sComment = (rejection.managerComments || "").trim() || "No reason provided by manager.";

  MessageBox.error(
    sComment,
    {
      title: "Leave Request Rejected",
      details: [
        "Leave Type: " + (rejection.leaveType || ""),
        "Period: " + this.formatDateRange(rejection.startDate, rejection.endDate),
        "Days: " + rejection.daysRequested,
        "Submitted: " + this.formatDateTime(rejection.submittedAt)
      ].join("\n"),
      actions: [MessageBox.Action.OK, "View My Requests"],
      emphasizedAction: MessageBox.Action.OK,
      onClose: (sAction) => {
        if (sAction === "View My Requests") {
          this.byId("myRequestsTable")
            ?.getDomRef()
            ?.scrollIntoView({ behavior: "smooth" });
        }
      }
    }
  );
},

    /**
     * ✅ CHANGED: Also show approval notification, and pass changeType to
     * _checkForRejectionNotifications so it only triggers on manager-initiated changes.
     */
   _onLeaveChanged: async function (sChannel, sEvent, oData) {
  try {
    const myEmpId = this.getOwnerComponent().getModel("user")?.getProperty("/employeeId");
    if (!myEmpId) return;

    // If a specific employeeId is given and it's not us, skip
    if (oData && oData.employeeId && oData.employeeId !== myEmpId) return;

    // Only react to manager-initiated changes (not our own submissions looping back)
    const isManagerChange = oData && oData.source === "manager";

    // Refresh all leave data so the model gets the latest managerComments from DB
    const requests = await this._refreshOwnLeaveData();

    if (isManagerChange && oData.change === "approved") {
      MessageToast.show("Your leave request has been approved!");

    } else if (isManagerChange && oData.change === "rejected") {
      // ✅ Pass the specific requestId from the EventBus payload
      // so we show the comment for exactly the request that was just rejected
      this._checkForRejectionNotifications(requests || [], oData.requestId || null);
    }

  } catch (e) {
    console.error("_onLeaveChanged error:", e);
  }
},

    // ===== Full details dialog (row press) =====
    onViewRequestDetails: function (oEvent) {
      const ctx = oEvent.getSource().getBindingContext("leaveRequests");
      const oData = ctx && ctx.getObject();
      if (!oData) return;

      const sFragId = this.getView().getId() + "--requestDetailsFrag";

      if (!this._pRequestDetailsDlg) {
        this._pRequestDetailsDlg = Fragment.load({
          name: "lmsui5.view.RequestDetail",
          controller: this,
          id: sFragId
        }).then(function (oDialog) {
          this.getView().addDependent(oDialog);
          return oDialog;
        }.bind(this)).catch(function (e) {
          console.error("RequestDetail fragment load failed:", e);
          MessageBox.error(e.message || "Failed to open the details dialog.");
        });
      }

      this._pRequestDetailsDlg.then(function (oDialog) {
        oDialog.setBindingContext(ctx, "leaveRequests");
        oDialog.open();
      });
    },

    onCloseRequestDetails: function () {
      if (this._pRequestDetailsDlg) {
        this._pRequestDetailsDlg.then(function (oDialog) { oDialog.close(); });
      }
    },

    // ===== Apply Leave dialog =====
    onOpenApplyLeave: function () {
      const oApplyModel = this.getView().getModel("applyLeave");
      oApplyModel.setData(this._buildApplyLeaveModelData());

      const sFragId = this.getView().getId() + "--applyLeaveFrag";

      if (!this._pApplyLeaveDlg) {
        this._pApplyLeaveDlg = Fragment.load({
          name: "lmsui5.view.ApplyLeave",
          controller: this,
          id: sFragId
        }).then(function (oDialog) {
          this.getView().addDependent(oDialog);
          return oDialog;
        }.bind(this)).catch(function (e) {
          console.error("ApplyLeave fragment load failed:", e);
          MessageBox.error("Failed to load Apply Leave dialog.");
        });
      }

      this._pApplyLeaveDlg.then(function (oDialog) {
        const oCalendar = Fragment.byId(sFragId, "leaveCalendar");
        if (oCalendar) {
          if (oCalendar.setSingleSelection) oCalendar.setSingleSelection(true);
          if (oCalendar.setIntervalSelection) oCalendar.setIntervalSelection(true);
          oCalendar.removeAllSelectedDates();
        }
        oDialog.open();
      });
    },

    onCancelApplyLeave: function () {
      const sFragId = this.getView().getId() + "--applyLeaveFrag";
      if (this._pApplyLeaveDlg) {
        this._pApplyLeaveDlg.then(function (oDialog) {
          const oCalendar = Fragment.byId(sFragId, "leaveCalendar");
          if (oCalendar) oCalendar.removeAllSelectedDates();
          oDialog.close();
        });
      }
      this.getView().getModel("applyLeave").setData(this._buildApplyLeaveModelData());
    },

    onCalendarSelect: function (oEvent) {
      const oCalendar = oEvent.getSource();
      const aRanges = oCalendar.getSelectedDates() || [];
      const oRange = aRanges[0];
      const oModel = this.getView().getModel("applyLeave");

      if (oRange) {
        const start = oRange.getStartDate();
        const end = oRange.getEndDate() || start;
        const startISO = this._toISODate(start);
        const endISO = this._toISODate(end);
        const aBusinessISO = this._expandBusinessDates(start, end);
        const businessDays = aBusinessISO.length;

        oModel.setProperty("/startDate", start);
        oModel.setProperty("/endDate", end);
        oModel.setProperty("/startDateISO", startISO);
        oModel.setProperty("/endDateISO", endISO);
        oModel.setProperty("/totalDays", businessDays);
        oModel.setProperty("/selectedDates", aBusinessISO);
        oModel.setProperty("/rangeText", businessDays
          ? `Selected: ${startISO} → ${endISO} (${businessDays} business day${businessDays > 1 ? "s" : ""})`
          : `Selected: ${startISO} → ${endISO} (0 business days — weekends excluded)`);
      } else {
        oModel.setProperty("/startDate", null);
        oModel.setProperty("/endDate", null);
        oModel.setProperty("/startDateISO", "");
        oModel.setProperty("/endDateISO", "");
        oModel.setProperty("/totalDays", 0);
        oModel.setProperty("/selectedDates", []);
        oModel.setProperty("/rangeText", "");
      }
    },

    onSubmitLeave: async function () {
      const oApply = this.getView().getModel("applyLeave");
      const sEmployeeId = this.getOwnerComponent().getModel("user")?.getProperty("/employeeId");

      const sLeaveType = oApply.getProperty("/selectedLeaveType");
      const sStart = oApply.getProperty("/startDateISO");
      const sEnd   = oApply.getProperty("/endDateISO");
      const sReason = (oApply.getProperty("/reason") || "").trim();

      if (!sLeaveType) return MessageBox.warning("Please select a leave type.");
      if (!sStart || !sEnd) return MessageBox.warning("Please select a valid date range.");

      try {
        const oModel = this.getView().getModel();
        const oCtx = oModel.bindContext("/submitLeaveRequest(...)");
        oCtx.setParameter("employeeId",    sEmployeeId);
        oCtx.setParameter("leaveTypeCode", sLeaveType);
        oCtx.setParameter("startDate",     sStart);
        oCtx.setParameter("endDate",       sEnd);
        oCtx.setParameter("reason",        sReason);
        await oCtx.execute();

        MessageToast.show("Leave application submitted.");
        this.onCancelApplyLeave();
        await this._refreshOwnLeaveData();

        sap.ui.getCore().getEventBus().publish("leave", "changed", {
          employeeId: sEmployeeId,
          source: "employee",
          change: "submitted"
        });

      } catch (e) {
        console.error("Submit leave error:", e);
        MessageBox.error(e.message || "Failed to submit leave request");
      }
    },

    // ============== helpers for dates ==============

    _buildApplyLeaveModelData: function () {
      return {
        selectedLeaveType: "",
        leaveTypes: this._getAvailableLeaveTypes(),
        minDate: this._getTodayStart(),
        maxDate: this._getYearEnd(),
        startDate: null,
        endDate: null,
        startDateISO: "",
        endDateISO: "",
        totalDays: 0,
        selectedDates: [],
        rangeText: "",
        reason: ""
      };
    },

    _getAvailableLeaveTypes: function () {
      const oUser = this.getOwnerComponent().getModel("user");
      const unique = new Map();

      const aTypes = oUser?.getProperty("/leaveTypes");
      if (Array.isArray(aTypes) && aTypes.length) {
        aTypes.forEach(function (t) {
          const code = t.code || t.leaveTypeCode || "";
          const desc = t.description || t.code || "";
          if (code && !unique.has(code)) unique.set(code, { code, description: desc });
        });
      }

      const aBalances = oUser?.getProperty("/leaveBalances") || [];
      aBalances.forEach(function (b) {
        const code = b.leaveTypeCode;
        const desc = b.leaveTypeDescription || b.description || code;
        if (code && !unique.has(code)) unique.set(code, { code, description: desc });
      });

      if (unique.size === 0) {
        return [
          { code: "CL", description: "Casual Leave" },
          { code: "SL", description: "Sick Leave" },
          { code: "EL", description: "Earned Leave" }
        ];
      }
      return Array.from(unique.values());
    },

    _getTodayStart: function () {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d;
    },

    _getYearEnd: function () {
      const d = new Date();
      d.setMonth(11, 31);
      d.setHours(23, 59, 59, 999);
      return d;
    },

    _toISODate: function (dateObj) {
      const y = dateObj.getFullYear();
      const m = String(dateObj.getMonth() + 1).padStart(2, "0");
      const d = String(dateObj.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    },

    _isWeekend: function (dateObj) {
      const day = dateObj.getDay();
      return day === 0 || day === 6;
    },

    _expandBusinessDates: function (start, end) {
      const out = [];
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate());
      const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
      while (d <= last) {
        if (!this._isWeekend(d)) out.push(this._toISODate(d));
        d.setDate(d.getDate() + 1);
      }
      return out;
    },

    /** ✅ CHANGED: Returns the loaded requests so _onLeaveChanged can use them */
    _refreshOwnLeaveData: async function () {
      const balBinding = this.byId("balancesTable")?.getBinding("items");
      balBinding?.refresh();

      const requests = await this._loadMyLeaveRequests();

      try {
        const username = this.getOwnerComponent().getModel("auth")?.getProperty("/username");
        if (username) {
          const res = await fetch("/odata/v4/my-services/getEmployeeData", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: username })
          });
          if (res.ok) {
            const data = await res.json();
            const oUserModel = this.getOwnerComponent().getModel("user");
            if (oUserModel && data.employee) {
              oUserModel.setProperty("/leaveBalances", data.leaveBalances || []);
            }
          }
        }
      } catch (e) {
        // silent
      }

      return requests; // ✅ CHANGED: return so callers can check
    },

    /* ===================== Manager Message dialog ===================== */

    __mmFallback: function (s) {
      if (s && String(s).trim()) return s;
      return "No message from manager yet.";
    },

    onOpenManagerMessage: function (oEvent) {
      const ctx = oEvent.getSource().getBindingContext("leaveRequests") || oEvent.getSource().getBindingContext();
      if (!ctx) {
        return sap.m.MessageToast.show("No request selected.");
      }

      const sFragId = this.getView().getId() + "--managerMessageFrag";

      if (!this._pManagerMsgDlg) {
        this._pManagerMsgDlg = Fragment.load({
          name: "lmsui5.view.ManagerMessageDialog",
          controller: this,
          id: sFragId
        }).then(function (oDialog) {
          this.getView().addDependent(oDialog);
          return oDialog;
        }.bind(this)).catch(function (e) {
          console.error("ManagerMessageDialog load failed:", e);
          MessageBox.error(e.message || "Failed to open the message dialog.");
        });
      }

      this._pManagerMsgDlg.then(function (oDialog) {
        oDialog.setBindingContext(ctx, "leaveRequests");
        oDialog.open();
      });
    },

    onCloseManagerMessage: function () {
      if (this._pManagerMsgDlg) {
        this._pManagerMsgDlg.then(function (oDialog) { oDialog.close(); });
      }
    },

    onManagerMessageLiveChange: function () {
      // reserved (TextArea is read-only)
    },

    onCopyManagerMessage: function () {
      const sFragId = this.getView().getId() + "--managerMessageFrag";
      const oTA = Fragment.byId(sFragId, "mmText");
      const text = oTA?.getValue() || "";

      if (!navigator.clipboard) {
        try {
          const temp = document.createElement("textarea");
          temp.value = text; temp.style.position = "fixed"; temp.style.left = "-9999px";
          document.body.appendChild(temp); temp.select(); document.execCommand("copy");
          document.body.removeChild(temp);
          MessageToast.show("Message copied");
        } catch (e) {
          MessageBox.information("Copy not available on this browser.");
        }
        return;
      }
      navigator.clipboard.writeText(text).then(
        () => MessageToast.show("Message copied"),
        () => MessageBox.information("Copy not available on this browser.")
      );
    }

  });
});