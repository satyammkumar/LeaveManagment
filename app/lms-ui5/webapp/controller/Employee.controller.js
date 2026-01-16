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

      // Prepare transient model for Apply Leave dialog
      this.getView().setModel(new JSONModel(this._buildApplyLeaveModelData()), "applyLeave");

      // Route → load employee data when navigated with { username } (email)
      const oRouter = this.getOwnerComponent().getRouter();
      oRouter.getRoute("Employee").attachPatternMatched(this._onRouteMatched, this);

      // Apply filter by employeeId after table is visible/bound
      this.getView().addEventDelegate({
        onAfterShow: function () {
          this._applyEmployeeFilter();
        }.bind(this)
      });
    },

    /** Load employee profile by email via CAP action and set user model */
    getEmployeeData: async function (sUsername) {
      // Basic email validation
      const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailPattern.test(sUsername)) {
        this._showError("Please enter a valid email address.");
        return;
      }

      const msgStrip = this.byId("msg"); // if present in view
      if (msgStrip) msgStrip.setVisible(false);

      try {
        console.log("Calling API with username:", sUsername);

        // POST to CAP action (kept as you wrote: /odata/v4/my-services/getEmployeeData)
        const res = await fetch("/odata/v4/my-services/getEmployeeData", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: sUsername })
        });

        // Robust error handling with clone fallback
        if (!res.ok) {
          const resClone = res.clone();
          let errTxt = "Failed to fetch employee data";
          try { errTxt = (await res.json())?.error?.message || errTxt; }
          catch { try { errTxt = await resClone.text(); } catch {} }
          throw new Error(errTxt);
        }

        // Read the body exactly once
        const data = await res.json();
        console.log("Employee data received:", data);

        // Update 'user' model with flattened employee fields
        const oUserModel = this.getOwnerComponent().getModel("user");
        if (oUserModel && data.employee) {
          oUserModel.setProperty("/id", data.employee.id);
          oUserModel.setProperty("/employeeId", data.employee.employeeID); // mapping from action result
          oUserModel.setProperty("/firstName", data.employee.firstName);
          oUserModel.setProperty("/lastName", data.employee.lastName);
          oUserModel.setProperty("/email", data.employee.email);
          oUserModel.setProperty("/department", data.employee.department);
          oUserModel.setProperty("/managerId", data.employee.managerID);

          // Derived full name for header greeting
          const fullName = `${data.employee.firstName || ""} ${data.employee.lastName || ""}`.trim();
          oUserModel.setProperty("/fullName", fullName);

          // If backend returns leave balances inline (optional)
          if (data.leaveBalances && Array.isArray(data.leaveBalances)) {
            oUserModel.setProperty("/leaveBalances", data.leaveBalances);
            console.log("Leave balances stored:", data.leaveBalances);
          }

          console.log("User model updated:", oUserModel.getData());
        }

        MessageToast.show("Employee data loaded successfully");
        // Re-apply filter after data is set
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

      console.log("Route parameter (username):", sUsername);

      const authModel = this.getOwnerComponent().getModel("auth");
      if (authModel && sUsername) {
        authModel.setProperty("/username", sUsername);
      }

      if (sUsername) {
        // Load employee profile immediately
        this.getEmployeeData(sUsername);
      }
    },

    /** Apply table filter: LeaveBalance for current employeeId */
    _applyEmployeeFilter: function () {
      const oUserModel = this.getOwnerComponent().getModel("user");
      const sEmpId = oUserModel && oUserModel.getProperty("/employeeId");
      console.log("Filtering by employeeId:", sEmpId);

      const oTable = this.byId("balancesTable");
      const oBinding = oTable?.getBinding("items");
      if (!oBinding) return;

      if (sEmpId) {
        // Use nav property if supported; else use FK column: "employee_employeeId"
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

    /** Logout: clear models, clear remembered email (optional), navigate to Login, replace history */
    onLogout: function () {
      // Clear user model
      const oUserModel = this.getOwnerComponent().getModel("user");
      if (oUserModel) {
        oUserModel.setData({});
      }

      // Clear auth model
      const authModel = this.getOwnerComponent().getModel("auth");
      if (authModel) {
        authModel.setData({});
      }

      try { localStorage.removeItem("login_email"); } catch (e) {}

      const oODataModel = this.getOwnerComponent().getModel("");
      if (oODataModel && oODataModel.refresh) {
        oODataModel.refresh();
      }

      this.getOwnerComponent().getRouter().navTo("Login", {}, true);
    },

    formatBalanceState: function (v) {
      const n = Number(v);
      if (isNaN(n)) return "None";
      if (n < 0) return "Error";
      if (n === 0) return "Warning";
      return "Success";
    },


    onOpenApplyLeave: function () {
      // Refresh transient data to current employee context
      const oApplyModel = this.getView().getModel("applyLeave");
      oApplyModel.setData(this._buildApplyLeaveModelData());

      // Give the fragment an ID prefix scoped to this view
      const sFragId = this.getView().getId() + "--applyLeaveFrag";

      // Lazy-load fragment only once
      if (!this._pApplyLeaveDlg) {
        this._pApplyLeaveDlg = Fragment.load({
          name: "lmsui5.view.ApplyLeave",   // adjust if your file is under /fragments
          controller: this,
          id: sFragId
        }).then(function (oDialog) {
          this.getView().addDependent(oDialog); // inherit models/lifecycle
          return oDialog;
        }.bind(this)).catch(function (e) {
          console.error("Fragment load failed:", e);
          MessageBox.error("Failed to load Apply Leave dialog. Check fragment path or manifest libs.");
        });
      }

      this._pApplyLeaveDlg.then(function (oDialog) {
        // Access the calendar within the fragment using Fragment.byId
        const oCalendar = Fragment.byId(sFragId, "leaveCalendar");
        if (oCalendar) {
          // Enforce single interval selection (start + end only)
          if (oCalendar.setSingleSelection) oCalendar.setSingleSelection(true);
          if (oCalendar.setIntervalSelection) oCalendar.setIntervalSelection(true);

          // Clear any previous selection
          oCalendar.removeAllSelectedDates();
        }
        oDialog.open();
      });
    },

    onCancelApplyLeave: function () {
      const sFragId = this.getView().getId() + "--applyLeaveFrag";

      if (this._pApplyLeaveDlg) {
        this._pApplyLeaveDlg.then(function (oDialog) {
          // Clear calendar selection on cancel
          const oCalendar = Fragment.byId(sFragId, "leaveCalendar");
          if (oCalendar) {
            oCalendar.removeAllSelectedDates();
          }
          oDialog.close();
        });
      }
      // Reset transient model back to defaults (based on logged-in employee)
      this.getView().getModel("applyLeave").setData(this._buildApplyLeaveModelData());
    },

   
onCalendarSelect: function (oEvent) {
  const oCalendar = oEvent.getSource();
  const aRanges = oCalendar.getSelectedDates() || [];
  const oRange = aRanges[0];  // single interval only

  const oModel = this.getView().getModel("applyLeave");

  if (oRange) {
    const start = oRange.getStartDate();
    const end = oRange.getEndDate() || start; // single-day if end missing

    const startISO = this._toISODate(start);
    const endISO = this._toISODate(end);

    // Expand to weekdays only (Mon–Fri)
    const aBusinessISO = this._expandBusinessDates(start, end);
    const businessDays = aBusinessISO.length;

    // Update transient model
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
    // Reset when nothing selected
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
  const sLeaveType = oApply.getProperty("/selectedLeaveType");
  const aDates = oApply.getProperty("/selectedDates"); // already weekday-only
  const sReason = oApply.getProperty("/reason") || "";

  if (!sLeaveType) {
    MessageBox.warning("Please select a leave type.");
    return;
  }
  if (!aDates || !aDates.length) {
    MessageBox.warning("Please select a range that includes at least one weekday (Mon–Fri).");
    return;
  }

  const sEmployeeId = this.getOwnerComponent().getModel("user")?.getProperty("/employeeId");
  const payload = {
    employeeId: sEmployeeId,
    leaveTypeCode: sLeaveType,
    dates: aDates,   // array of weekdays only, 'YYYY-MM-DD'
    reason: sReason
  };

  try {
    console.log("Leave payload:", payload);

    // TODO: Call backend (OData V4 or CAP REST)
    // const oModel = this.getOwnerComponent().getModel();
    // const list = oModel.bindList("/LeaveRequests");
    // const ctx = list.create(payload);
    // await ctx.created();

    MessageToast.show(`Leave application submitted for ${aDates.length} business day(s).`);
    this.onCancelApplyLeave();
    if (this.onRefresh) this.onRefresh();
  } catch (e) {
    console.error("Submit leave error:", e);
    MessageBox.error(e.message || "Failed to submit leave request");
  }
},


    onExit: function () {
      if (this._pApplyLeaveDlg) {
        this._pApplyLeaveDlg.then(function (oDialog) {
          oDialog.destroy();
        });
        this._pApplyLeaveDlg = null;
      }
    },

    // =========================
    // Helpers
    // =========================

    _buildApplyLeaveModelData: function () {
      return {
        selectedLeaveType: "",
        leaveTypes: this._getAvailableLeaveTypes(), // unique list of types
        minDate: this._getTodayStart(),
        maxDate: this._getYearEnd(),
        startDate: null,
        endDate: null,
        startDateISO: "",
        endDateISO: "",
        totalDays: 0,
        selectedDates: [],   // expanded array of ISO dates
        rangeText: "",
        reason: ""
      };
    },

    _getAvailableLeaveTypes: function () {
      const oUser = this.getOwnerComponent().getModel("user");
      const unique = new Map();

      // Prefer explicit `/leaveTypes` if present
      const aTypes = oUser?.getProperty("/leaveTypes");
      if (Array.isArray(aTypes) && aTypes.length) {
        aTypes.forEach(function (t) {
          const code = t.code || t.leaveTypeCode || "";
          const desc = t.description || t.code || "";
          if (code && !unique.has(code)) unique.set(code, { code, description: desc });
        });
      }

      // Fallback: derive types from `/leaveBalances`
      const aBalances = oUser?.getProperty("/leaveBalances") || [];
      aBalances.forEach(function (b) {
        const code = b.leaveTypeCode;
        const desc = b.leaveTypeDescription || b.description || code;
        if (code && !unique.has(code)) unique.set(code, { code, description: desc });
      });

      // Final fallback: static defaults
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
      d.setMonth(11, 31); // Dec 31
      d.setHours(23, 59, 59, 999);
      return d;
    },

    _toISODate: function (dateObj) {
      const y = dateObj.getFullYear();
      const m = String(dateObj.getMonth() + 1).padStart(2, "0");
      const d = String(dateObj.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    },

    _diffDaysInclusive: function (start, end) {
      const msPerDay = 24 * 60 * 60 * 1000;
      const s = new Date(start.getFullYear(), start.getMonth(), start.getDate());
      const e = new Date(end.getFullYear(), end.getMonth(), end.getDate());
      return Math.floor((e - s) / msPerDay) + 1;
    },

    _expandDates: function (start, end) {
      const out = [];
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate());
      const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
      while (d <= last) {
        out.push(this._toISODate(d));
        d.setDate(d.getDate() + 1);
      }
      return out;
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


  });
});