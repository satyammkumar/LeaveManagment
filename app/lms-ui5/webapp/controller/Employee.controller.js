
sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast",
  "sap/m/MessageBox",
  "sap/ui/core/Fragment"
], function (Controller, Filter, FilterOperator, JSONModel, MessageToast, MessageBox, Fragment) {
  "use strict";

  return Controller.extend("lmsui5.controller.Employee", {

    onInit: function () {
      // Ensure 'user' model exists on Component
      if (!this.getOwnerComponent().getModel("user")) {
        this.getOwnerComponent().setModel(new JSONModel({}), "user");
      }

      // Transient model for Apply Leave
      this.getView().setModel(new JSONModel(this._buildApplyLeaveModelData()), "applyLeave");

      // Route → load employee data when navigated with { username } (email)
      const oRouter = this.getOwnerComponent().getRouter();
      oRouter.getRoute("Employee").attachPatternMatched(this._onRouteMatched, this);

      // Apply filter by employeeId & refresh data after page is visible
      this.getView().addEventDelegate({
        onAfterShow: function () {
          this._applyEmployeeFilter();
          this._refreshOwnLeaveData(); // 🔄 keep page up to date when user returns
        }.bind(this)
      });

      // 🔔 Subscribe to leave change events (submitted/approved/rejected/cancelled)
      this._bus = sap.ui.getCore().getEventBus();
      this._bus.subscribe("leave", "changed", this._onLeaveChanged, this);
    },

    onExit: function () {
      // Clean up dialog and event subscriptions
      if (this._pApplyLeaveDlg) {
        this._pApplyLeaveDlg.then(function (oDialog) { oDialog.destroy(); });
        this._pApplyLeaveDlg = null;
      }
      if (this._bus) {
        this._bus.unsubscribe("leave", "changed", this._onLeaveChanged, this);
      }
    },

    /** Load employee profile by email via CAP action and set user model */
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

          if (data.leaveBalances && Array.isArray(data.leaveBalances)) {
            oUserModel.setProperty("/leaveBalances", data.leaveBalances);
          }
        }

        MessageToast.show("Employee data loaded successfully");
        this._applyEmployeeFilter();

      } catch (err) {
        this._showError(err.message || "Failed to load employee data");
        console.error("API Error:", err);
      }
    },

    _showError: function (sMessage) {
      MessageToast.show(sMessage, { duration: 3000 });
    },

    /** Router handler — receives email as route argument */
    _onRouteMatched: function (oEvent) {
      const oArgs = oEvent.getParameter("arguments");
      const sUsername = oArgs.username;

      const authModel = this.getOwnerComponent().getModel("auth");
      if (authModel && sUsername) {
        authModel.setProperty("/username", sUsername);
      }

      if (sUsername) {
        this.getEmployeeData(sUsername);
      }
    },

    /** Apply table filter: LeaveBalances for current employeeId */
    _applyEmployeeFilter: function () {
      const oUserModel = this.getOwnerComponent().getModel("user");
      const sEmpId = oUserModel && oUserModel.getProperty("/employeeId");

      const oTable = this.byId("balancesTable");
      const oBinding = oTable?.getBinding("items");
      if (!oBinding) return;

      if (sEmpId) {
        const aFilters = [new Filter("employee/employeeId", FilterOperator.EQ, sEmpId)];
        oBinding.filter(aFilters);
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
      const oTable = this.byId("balancesTable");
      const oBinding = oTable?.getBinding("items");
      if (!oBinding) return;

      const aFilters = [];
      const oUserModel = this.getOwnerComponent().getModel("user");
      const sEmpId = oUserModel && oUserModel.getProperty("/employeeId");
      if (sEmpId) {
        aFilters.push(new Filter("employee/employeeId", FilterOperator.EQ, sEmpId));
      }

      if (sQuery) {
        const oOr = new Filter({
          filters: [
            new Filter("leaveType/code", FilterOperator.Contains, sQuery),
            new Filter("leaveType/description", FilterOperator.Contains, sQuery)
          ],
          and: false
        });
        aFilters.push(oOr);
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
    },

    /** Logout */
onLogout: function () {
  var that = this;

  sap.m.MessageBox.confirm("Are you sure you want to logout?", {
    actions: [sap.m.MessageBox.Action.OK, sap.m.MessageBox.Action.CANCEL],
    emphasizedAction: sap.m.MessageBox.Action.OK,
    onClose: function (sAction) {
      if (sAction !== sap.m.MessageBox.Action.OK) { return; }

      // Clear light client-side state
      try { sessionStorage.clear(); } catch (e) {}
      try { localStorage.clear(); } catch (e) {}

      // FLP home navigation (no await; don’t throw)
      if (sap.ushell && sap.ushell.Container) {
        try {
          // To FLP Home:
          window.location.hash = "#Shell-home";
          return;
        } catch (e) {
          // fall through to hard redirect
        }
      }

      // Fallback if not in FLP
      var oComp = that.getOwnerComponent && that.getOwnerComponent();
      var oRouter = oComp && oComp.getRouter && oComp.getRouter();
      if (oRouter && oRouter.navTo) {
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

    // ========= Apply Leave Dialog =========
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
          console.error("Fragment load failed:", e);
          MessageBox.error("Failed to load Apply Leave dialog. Check fragment path or manifest libs.");
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
      const oRange = aRanges[0];  // single interval only
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

    /** Final submit: call CAP action and sync UI */
    onSubmitLeave: async function () {
      const oApply = this.getView().getModel("applyLeave");
      const sEmployeeId = this.getOwnerComponent().getModel("user")?.getProperty("/employeeId");

      const sLeaveType = oApply.getProperty("/selectedLeaveType");
      const sStart = oApply.getProperty("/startDateISO");
      const sEnd   = oApply.getProperty("/endDateISO");
      const sReason = (oApply.getProperty("/reason") || "").trim();

      if (!sLeaveType) {
        return MessageBox.warning("Please select a leave type.");
      }
      if (!sStart || !sEnd) {
        return MessageBox.warning("Please select a valid date range.");
      }

      try {
        // --- OData V4 action call ---
        const oModel = this.getView().getModel();
        const oCtx = oModel.bindContext("/submitLeaveRequest(...)");
        oCtx.setParameter("employeeId",    sEmployeeId);
        oCtx.setParameter("leaveTypeCode", sLeaveType);
        oCtx.setParameter("startDate",     sStart);  // 'YYYY-MM-DD'
        oCtx.setParameter("endDate",       sEnd);    // 'YYYY-MM-DD'
        oCtx.setParameter("reason",        sReason);
        await oCtx.execute();

        MessageToast.show("Leave application submitted.");
        this.onCancelApplyLeave();

        // 🔄 Immediately refresh my view (OData table + JSON summary)
        await this._refreshOwnLeaveData();

        // 🔔 Notify other views (e.g., Manager) & other tabs
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

    // =========================
    // Helpers
    // =========================
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
      const day = dateObj.getDay(); // 0=Sun, 6=Sat
      return day === 0 || day === 6;
    },

    _expandBusinessDates: function (start, end) {
      const out = [];
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate());
      const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
      while (d <= last) {
        if (!this._isWeekend(d)) {
          out.push(this._toISODate(d));
        }
        d.setDate(d.getDate() + 1);
      }
      return out;
    },

    /** 🔁 Centralized self-refresh after any change for this employee */
    _refreshOwnLeaveData: async function () {
      // 1) Refresh the OData LeaveBalances table binding (keeps filters applied)
      const balBinding = this.byId("balancesTable")?.getBinding("items");
      balBinding?.refresh();

      // 2) Refresh the top “Leave Summary” in the local JSON 'user' model
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
              // Only update balances to keep other user info intact
              oUserModel.setProperty("/leaveBalances", data.leaveBalances || []);
            }
          }
        }
      } catch (e) {
        // It's okay if this fails; OData table is still refreshed
        // console.warn("Failed to reload getEmployeeData:", e);
      }
    },

    /** 🔔 EventBus callback: refresh only if the change is for THIS employee */
    _onLeaveChanged: function (sChannel, sEvent, oData) {
      try {
        const myEmpId = this.getOwnerComponent().getModel("user")?.getProperty("/employeeId");
        if (!myEmpId) return;

        if (oData && oData.employeeId && oData.employeeId !== myEmpId) {
          return; // event for another employee, ignore
        }

        // Same employee → refresh my view
        this._refreshOwnLeaveData();
      } catch (e) {
        // no-op
      }
    }

  });
});
