sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast",
  "sap/m/MessageBox",
  "sap/ui/core/format/DateFormat",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/ui/model/Sorter"
], function (Controller, JSONModel, MessageToast, MessageBox, DateFormat, Filter, FilterOperator, Sorter) {
  "use strict";

  // STATUS SORT PRIORITY 
  
  var _statusOrder = function (status) {
    switch ((status || "").toLowerCase()) {
      case "pending":   return 0;
      case "rejected":  return 1;
      case "approved":  return 2;
      case "cancelled": return 3;
      default:          return 4;
    }
  };

  return Controller.extend("lmsui5.controller.Manager", {

    // INITIALIZATION 

    onInit: function () {
      const oViewModel = new JSONModel({
        kpi: {
          pending: 0,
          approvedToday: 0,
          rejectedToday: 0
        },
        counts: {
          leaveRequests: ""
        },
        leaveTypes: [],
        leaveTypeDescByCode: {},
        leaveTypeFullDescByCode: {},
        rejectData: {
          employeeName: "",
          leaveType: "",
          comments: "",
          commentLength: 0,
          requestId: "",
          isBulk: false,
          bulkRequests: []
        },
        // Generate Leaves dialog state 
        generateLeaves: {
          employeeId:      "",
          earnedDays:      0,
          optionalDays:    0,
          totalDays:       0,
          empMessage:      "",
          empMessageType:  "None"
        },
        busy: true,
        dataLoaded: false,
        useActionFeed: false,
        lastActionEmployeeID: ""
      });

      this.getView().setModel(oViewModel, "view");
      this.byId("selStatus")?.setSelectedKey("empty");

      const oModel = this.getView().getModel();
      if (oModel && oModel.setSizeLimit) {
        oModel.setSizeLimit(10000);
      }

      this._bus = sap.ui.getCore().getEventBus();
      this._loadLeaveTypes();
    },

    onExit: function () {},

    // LOOKUP LOADERS 

    _loadLeaveTypes: function () {
      const oModel = this.getView().getModel();
      const oViewModel = this.getView().getModel("view");

      if (!oModel || !oModel.read) {
        console.error("OData model not available");
        oViewModel.setProperty("/busy", false);
        return;
      }

      oModel.read("/LeaveTypes", {
        urlParameters: { $select: "code,description" },
        success: (data) => {
          const aLeaveTypes = data?.results || data?.value || [];
          const descByCode = {};
          const fullDescByCode = {};

          aLeaveTypes.forEach(lt => {
            const code = String(lt.code).trim().toUpperCase();
            const desc = lt.description || "";
            descByCode[code] = desc || code;
            fullDescByCode[code] = desc ? `${code} - ${desc}` : code;
          });

          oViewModel.setProperty("/leaveTypes", aLeaveTypes);
          oViewModel.setProperty("/leaveTypeDescByCode", descByCode);
          oViewModel.setProperty("/leaveTypeFullDescByCode", fullDescByCode);
          oViewModel.setProperty("/dataLoaded", true);
          oViewModel.setProperty("/busy", false);

          this._refreshTableBindings();
        },
        error: (err) => {
          console.error("Error loading leave types:", err);
          MessageToast.show("Error loading leave type data");
          oViewModel.setProperty("/dataLoaded", true);
          oViewModel.setProperty("/busy", false);
          this._refreshTableBindings();
        }
      });
    },

    _refreshTableBindings: function () {
      try {
        const oTable = this.byId("tblRequests");
        const oBinding = oTable?.getBinding("items");
        if (oBinding?.refresh) oBinding.refresh(true);
      } catch (e) {
        console.warn("Could not refresh bindings:", e.message);
      }
    },

    // FORMATTERS 

    formatLeaveTypeDesc: function (code) {
      if (!code) return "";
      try {
        const oViewModel = this.getView()?.getModel("view");
        if (!oViewModel) return String(code);
        if (!oViewModel.getProperty("/dataLoaded")) return String(code);
        const map = oViewModel.getProperty("/leaveTypeDescByCode") || {};
        return map[String(code).trim().toUpperCase()] || code;
      } catch (e) { return String(code); }
    },

    formatLeaveTypeFullDesc: function (code) {
      if (!code) return "";
      try {
        const oViewModel = this.getView()?.getModel("view");
        if (!oViewModel) return String(code);
        if (!oViewModel.getProperty("/dataLoaded")) return String(code);
        const map = oViewModel.getProperty("/leaveTypeFullDescByCode") || {};
        return map[String(code).trim().toUpperCase()] || code;
      } catch (e) { return String(code); }
    },

    formatDateRange: function (sStart, sEnd) {
      if (!sStart && !sEnd) return "";
      try {
        const fmt = DateFormat.getDateInstance({ style: "medium" });
        const a = sStart ? fmt.format(new Date(sStart)) : "";
        const b = sEnd   ? fmt.format(new Date(sEnd))   : "";
        return a && b ? `${a} → ${b}` : (a || b);
      } catch (e) { return `${sStart || ""} → ${sEnd || ""}`; }
    },

    formatDateTime: function (sDateTime) {
      if (!sDateTime) return "";
      try {
        return DateFormat.getDateTimeInstance({ style: "medium" }).format(new Date(sDateTime));
      } catch (e) { return sDateTime; }
    },

    formatStatusState: function (s) {
      switch ((s || "").toLowerCase()) {
        case "pending":   return "Warning";
        case "approved":  return "Success";
        case "rejected":  return "Error";
        case "cancelled": return "None";
        default:          return "None";
      }
    },

    // TABLE EVENTS 

    onUpdateFinished: function (oEvent) {
      const oTable = this.byId("tblRequests");
      const oBinding = oTable?.getBinding("items");
      let iTotal = oEvent.getParameter("total");
      if ((iTotal === undefined || iTotal === null) && oBinding?.getLength) {
        iTotal = oBinding.getLength();
      }
      const oViewModel = this.getView().getModel("view");
      oViewModel.setProperty("/counts/leaveRequests", iTotal ? `(${iTotal})` : "");
      this.byId("msEmpty")?.setVisible(!iTotal || iTotal === 0);
      this._updateKPIs();
    },

    _updateKPIs: function () {
      const aItems = this.byId("tblRequests")?.getItems() || [];
      const oViewModel = this.getView().getModel("view");
      let pending = 0, approvedToday = 0, rejectedToday = 0;
      const today = new Date(); today.setHours(0, 0, 0, 0);

      aItems.forEach(item => {
        const obj = item.getBindingContext()?.getObject();
        if (!obj) return;
        const status = (obj.status || "").toLowerCase();
        if (status === "pending") {
          pending++;
        } else if (status === "approved" && obj.approvedAt) {
          const d = new Date(obj.approvedAt); d.setHours(0, 0, 0, 0);
          if (d.getTime() === today.getTime()) approvedToday++;
        } else if (status === "rejected" && obj.approvedAt) {
          const d = new Date(obj.approvedAt); d.setHours(0, 0, 0, 0);
          if (d.getTime() === today.getTime()) rejectedToday++;
        }
      });

      oViewModel.setProperty("/kpi/pending", pending);
      oViewModel.setProperty("/kpi/approvedToday", approvedToday);
      oViewModel.setProperty("/kpi/rejectedToday", rejectedToday);
    },

    onSelectionChange: function () {
      const bHas = (this.byId("tblRequests")?.getSelectedItems()?.length || 0) > 0;
      this.byId("btnApproveSel")?.setEnabled(bHas);
      this.byId("btnRejectSel")?.setEnabled(bHas);
    },

    onRowPress: function (oEvent) {
      const ctx = oEvent.getSource().getBindingContext();
      const oPopover = this.byId("popDetails");
      if (oPopover && ctx) {
        oPopover.setBindingContext(ctx);
        oPopover.openBy(oEvent.getSource());
      }
    },

    // FILTERS & SEARCH 

    onStatusChange: function () { this._applyFilters(); },
    onDateRangeChange: function () { this._applyFilters(); },
    onLiveSearch: function () { this._applyFilters(); },

    onSearch: function () {
      const s = (this.byId("reqSearch")?.getValue() || "").trim();
      const isEmployeeID = /^[A-Za-z]{2,}\d{2,}$|^\d{3,}$/.test(s);
      if (isEmployeeID) {
        this.loadRequestsForEmployee(s);
      } else if (!s) {
        this.loadRequestsForEmployee("");
      } else {
        this._applyFilters();
      }
    },

    onClearFilters: function () {
      this.byId("selStatus")?.setSelectedKey("All");
      this.byId("reqSearch")?.setValue("");
      this.loadRequestsForEmployee("");
      this._applyFilters();
    },

    onRefresh: function () {
      const oBinding = this.byId("tblRequests")?.getBinding("items");
      const oViewModel = this.getView().getModel("view");
      const useAction = !!oViewModel.getProperty("/useActionFeed");
      if (useAction) {
        const lastEmp = oViewModel.getProperty("/lastActionEmployeeID");
        if (lastEmp) { this.loadRequestsForEmployee(lastEmp); return; }
      }
      if (oBinding?.refresh) oBinding.refresh();
      MessageToast.show("Refreshed");
    },

    _applyFilters: function () {
      const oBinding = this.byId("tblRequests")?.getBinding("items");
      if (!oBinding) return;
      const oViewModel = this.getView().getModel("view");
      const useAction = !!oViewModel.getProperty("/useActionFeed");
      const aFilters = [];

      const sStatus = this.byId("selStatus")?.getSelectedKey();
      if (sStatus && sStatus !== "All" && sStatus !== "empty") {
        aFilters.push(new Filter("status", FilterOperator.EQ, sStatus));
      }

      const q = this.byId("reqSearch")?.getValue();
      if (q && q.trim()) {
        if (useAction) {
          aFilters.push(new Filter({
            filters: [
              new Filter("empname", FilterOperator.Contains, q),
              new Filter("leaveType", FilterOperator.Contains, q),
              new Filter("reason", FilterOperator.Contains, q)
            ],
            and: false
          }));
        } else {
          aFilters.push(new Filter({
            filters: [
              new Filter("empname", FilterOperator.Contains, q),
              new Filter("employee_employeeId", FilterOperator.Contains, q),
              new Filter("leaveType_code", FilterOperator.Contains, q),
              new Filter("reason", FilterOperator.Contains, q)
            ],
            and: false
          }));
        }
      }
      oBinding.filter(aFilters);
    },

    //  ACTION FEED HELPERS

    _bindTableToAction: function (aRequests) {
      const oTable = this.byId("tblRequests");
      if (!oTable) return;

      const aSorted = (aRequests || []).slice().sort((a, b) => {
        const diff = _statusOrder(a.status) - _statusOrder(b.status);
        if (diff !== 0) return diff;
        const dA = a.submittedAt ? new Date(a.submittedAt).getTime() : 0;
        const dB = b.submittedAt ? new Date(b.submittedAt).getTime() : 0;
        return dB - dA;
      });

      const oActionModel = new JSONModel({ requests: aSorted });
      this.getView().setModel(oActionModel, "action");

      const oTemplate = oTable.getBindingInfo("items")?.template?.clone();
      oTable.unbindItems();
      oTable.bindItems({ path: "action>/requests", template: oTemplate });

      this.getView().getModel("view").setProperty("/useActionFeed", true);
      this._applyFilters();
    },

    _bindTableToOData: function () {
      const oTable = this.byId("tblRequests");
      if (!oTable) return;

      const oTemplate = oTable.getBindingInfo("items")?.template?.clone();
      const oStatusSorter = new Sorter("status", false, false, (a, b) => _statusOrder(a) - _statusOrder(b));
      const oDateSorter   = new Sorter("submittedAt", true);

      oTable.unbindItems();
      oTable.bindItems({
        path: "/LeaveRequests",
        template: oTemplate,
        parameters: { $count: true },
        sorter: [oStatusSorter, oDateSorter]
      });

      this.getView().getModel("view").setProperty("/useActionFeed", false);
    },

    //  ROW ACTIONS 

    onApproveOne: function (oEvent) {
      const oSource = oEvent.getSource();
      const useAction = !!this.getView().getModel("view").getProperty("/useActionFeed");
      const ctx = useAction ? oSource.getBindingContext("action") : oSource.getBindingContext();
      const oData = ctx?.getObject();
      if (!oData) { MessageBox.error("Could not read request data. Please refresh."); return; }

      const sName = oData.empname || oData.employee_employeeId || "Unknown";
      MessageBox.confirm(`Approve leave request for ${sName}?`, {
        onClose: (sAction) => {
          if (sAction === MessageBox.Action.OK) {
            this._approveRequest(oData.ID || oData.id, oData.employee_employeeId || oData.employeeId || "");
          }
        }
      });
    },

    onRejectOne: function (oEvent) {
      const oSource = oEvent.getSource();
      const useAction = !!this.getView().getModel("view").getProperty("/useActionFeed");
      const ctx = useAction ? oSource.getBindingContext("action") : oSource.getBindingContext();
      const oData = ctx?.getObject();
      if (!oData) { MessageBox.error("Could not read request data. Please refresh."); return; }
      this._openRejectDialog(oData);
    },

    onApproveFromPopover: function () {
      const oPopover = this.byId("popDetails");
      const oData = oPopover?.getBindingContext()?.getObject();
      if (!oData) return;
      const sName = oData.empname || oData.employee_employeeId || "Unknown";
      MessageBox.confirm(`Approve leave request for ${sName}?`, {
        onClose: (sAction) => {
          if (sAction === MessageBox.Action.OK) {
            this._approveRequest(oData.ID || oData.id, oData.employee_employeeId || oData.employeeId || "");
            oPopover.close();
          }
        }
      });
    },

    onRejectFromPopover: function () {
      const oPopover = this.byId("popDetails");
      const ctx = oPopover?.getBindingContext() || oPopover?.getBindingContext("action");
      const oData = ctx?.getObject();
      if (!oData) return;
      oPopover.close();
      this._openRejectDialog(oData);
    },

    onApproveSelected: function () {
      const aItems = this.byId("tblRequests")?.getSelectedItems() || [];
      if (!aItems.length) { MessageToast.show("Please select at least one request"); return; }
      const aReqs = aItems.map(i => {
        const o = i.getBindingContext().getObject();
        return { id: o.ID || o.id, employeeId: o.employee_employeeId || o.employeeId || "" };
      });
      MessageBox.confirm(`Approve ${aReqs.length} leave request(s)?`, {
        onClose: (s) => { if (s === MessageBox.Action.OK) this._approveMultipleRequests(aReqs); }
      });
    },

    onRejectSelected: function () {
      const aItems = this.byId("tblRequests")?.getSelectedItems() || [];
      if (!aItems.length) { MessageToast.show("Please select at least one request"); return; }
      const aReqs = aItems.map(i => {
        const o = i.getBindingContext().getObject();
        return {
          id: o.ID || o.id,
          empname: o.empname || o.employee_employeeId || "Unknown",
          leaveType: o.leaveType || this.formatLeaveTypeFullDesc(o.leaveType_code),
          employeeId: o.employee_employeeId || o.employeeId || ""
        };
      });
      this._openBulkRejectDialog(aReqs);
    },

    //  REJECT DIALOG

    _openRejectDialog: function (oData) {
      const sRequestId = oData.ID || oData.id || oData.requestId || "";
      if (!sRequestId) { MessageBox.error("Could not resolve request ID. Please refresh and try again."); return; }
      const oVM = this.getView().getModel("view");
      oVM.setProperty("/rejectData/employeeName", oData.empname || oData.employee_employeeId || "Unknown");
      oVM.setProperty("/rejectData/leaveType", oData.leaveType || this.formatLeaveTypeFullDesc(oData.leaveType_code));
      oVM.setProperty("/rejectData/comments", "");
      oVM.setProperty("/rejectData/commentLength", 0);
      oVM.setProperty("/rejectData/requestId", sRequestId);
      oVM.setProperty("/rejectData/isBulk", false);
      oVM.setProperty("/rejectData/employeeId", oData.employee_employeeId || oData.employeeId || "");
      this.byId("rejectCommentDialog")?.open();
    },

    _openBulkRejectDialog: function (aRequests) {
      const oVM = this.getView().getModel("view");
      oVM.setProperty("/rejectData/employeeName", `${aRequests.length} employees`);
      oVM.setProperty("/rejectData/leaveType", "Multiple requests");
      oVM.setProperty("/rejectData/comments", "");
      oVM.setProperty("/rejectData/commentLength", 0);
      oVM.setProperty("/rejectData/bulkRequests", aRequests);
      oVM.setProperty("/rejectData/isBulk", true);
      oVM.setProperty("/rejectData/employeeId", "");
      this.byId("rejectCommentDialog")?.open();
    },

    onCommentChange: function (oEvent) {
      const sValue = oEvent.getParameter("value") || "";
      this.getView().getModel("view").setProperty("/rejectData/commentLength", sValue.length);
    },

    onConfirmReject: function () {
      const oData = this.getView().getModel("view").getProperty("/rejectData");
      if (!oData.comments?.trim()) { MessageToast.show("Please enter rejection comments"); return; }
      if (oData.isBulk) {
        this._rejectMultipleRequests(oData.bulkRequests, oData.comments);
      } else {
        this._rejectRequest(oData.requestId, oData.comments, oData.employeeId);
      }
      this.byId("rejectCommentDialog")?.close();
    },

    onCancelReject: function () { this.byId("rejectCommentDialog")?.close(); },

    // GENERATE EMPLOYEE LEAVES — dialog handlers 

    /**
     * Opens the Generate Leaves dialog 
     */
    onOpenGenerateLeaves: function () {
      const oVM = this.getView().getModel("view");
      oVM.setProperty("/generateLeaves", {
        employeeId:     "",
        earnedDays:     0,
        optionalDays:   0,
        totalDays:      0,
        empMessage:     "",
        empMessageType: "None"
      });
      this.byId("generateLeavesDialog")?.open();
    },

    
    //  Closes the dialog without saving.
    
    onCancelGenerateLeaves: function () {
      this.byId("generateLeavesDialog")?.close();
    },

    
    //  Clears any previous validation message.
        onGenEmpIdChange: function () {
      const oVM  = this.getView().getModel("view");
      const sId  = (oVM.getProperty("/generateLeaves/employeeId") || "").trim();
      // Clear old message whenever the field changes
      oVM.setProperty("/generateLeaves/empMessage", "");
      oVM.setProperty("/generateLeaves/empMessageType", "None");
      if (!sId) return;
      // Simple format hint — actual existence is validated on submit
      const looks = /^[A-Za-z]{1,3}\d{2,}$|^\d{3,}$/.test(sId);
      if (!looks) {
        oVM.setProperty("/generateLeaves/empMessage", "Employee ID format looks unusual (e.g. E1001).");
        oVM.setProperty("/generateLeaves/empMessageType", "Warning");
      }
    },

    /**
     * Recalculates the total whenever Earned or Optional days change.
     */
    onGenDaysChange: function () {
      const oVM = this.getView().getModel("view");
      const earned   = Number(oVM.getProperty("/generateLeaves/earnedDays")   || 0);
      const optional = Number(oVM.getProperty("/generateLeaves/optionalDays") || 0);
      oVM.setProperty("/generateLeaves/totalDays", earned + optional);
    },

    /**
     * Validates inputs.
     */
    onConfirmGenerateLeaves: async function () {
      const oVM = this.getView().getModel("view");
      const gen  = oVM.getProperty("/generateLeaves");

      const sEmpId   = (gen.employeeId || "").trim();
      const earned   = Number(gen.earnedDays   || 0);
      const optional = Number(gen.optionalDays || 0);
      const total    = earned + optional;

      if (!sEmpId) {
        MessageBox.warning("Please enter an Employee ID.");
        return;
      }
      if (total < 1) {
        MessageBox.warning("Please enter at least 1 day for Earned or Optional leaves.");
        return;
      }

      sap.ui.core.BusyIndicator.show(0);

      try {
        const res = await fetch("/odata/v4/my-services/assignLeaveBalance", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            employeeId:   sEmpId,
            earnedDays:   earned,
            optionalDays: optional
          })
        });

        sap.ui.core.BusyIndicator.hide();

        if (!res.ok) {
          let errMsg = "Failed to assign leave balance.";
          try { errMsg = (await res.json())?.error?.message || errMsg; } catch (e) {}
          // Show the error inside the dialog strip so the manager can correct it
          oVM.setProperty("/generateLeaves/empMessage", errMsg);
          oVM.setProperty("/generateLeaves/empMessageType", "Error");
          return;
        }

        const data = await res.json();

        // Close dialog on success
        this.byId("generateLeavesDialog")?.close();

        MessageToast.show(
          `Leave balance assigned to ${sEmpId}: ` +
          `Earned ${earned} day(s), Optional ${optional} day(s) — Total ${total} day(s).`
        );

        // Refresh employee view for balance table
        this._bus.publish("leave", "changed", {
          employeeId: sEmpId,
          source:     "manager",
          change:     "balanceAssigned",
          earned:     earned,
          optional:   optional,
          total:      total
        });

        console.log("[assignLeaveBalance] success:", data);

      } catch (e) {
        sap.ui.core.BusyIndicator.hide();
        console.error("assignLeaveBalance error:", e);
        oVM.setProperty("/generateLeaves/empMessage", e.message || "Failed to assign leave balance.");
        oVM.setProperty("/generateLeaves/empMessageType", "Error");
      }
    },

    // BACKEND CALLS 

    _approveRequest: async function (sRequestId, sEmployeeId) {
      const sApproverId = this._getApproverId();
      sap.ui.core.BusyIndicator.show(0);
      try {
        const res = await fetch("/odata/v4/my-services/approveLeaveRequest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId: sRequestId, approverId: sApproverId, comments: "" })
        });
        sap.ui.core.BusyIndicator.hide();
        if (!res.ok) {
          let e = "Failed to approve leave request.";
          try { e = (await res.json())?.error?.message || e; } catch (_) {}
          MessageBox.error(e); return;
        }
        MessageToast.show("Leave request approved successfully");
        this._bus.publish("leave", "changed", {
          employeeId: sEmployeeId || "", source: "manager", change: "approved", requestId: sRequestId
        });
        this.onRefresh();
      } catch (e) {
        sap.ui.core.BusyIndicator.hide();
        MessageBox.error("Failed to approve leave request.");
      }
    },

    _rejectRequest: async function (sRequestId, sComments, sEmployeeId) {
      const sApproverId = this._getApproverId();
      sap.ui.core.BusyIndicator.show(0);
      try {
        const res = await fetch("/odata/v4/my-services/rejectLeaveRequest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId: sRequestId, approverId: sApproverId, comments: sComments })
        });
        sap.ui.core.BusyIndicator.hide();
        if (!res.ok) {
          let e = "Failed to reject leave request.";
          try { e = (await res.json())?.error?.message || e; } catch (_) {}
          MessageBox.error(e); return;
        }
        MessageToast.show("Leave request rejected successfully");
        this._bus.publish("leave", "changed", {
          employeeId: sEmployeeId || "", source: "manager", change: "rejected",
          requestId: sRequestId, comments: sComments
        });
        this.onRefresh();
      } catch (e) {
        sap.ui.core.BusyIndicator.hide();
        MessageBox.error("Failed to reject leave request.");
      }
    },

    _approveMultipleRequests: async function (aRequests) {
      const sApproverId = this._getApproverId();
      let ok = 0, fail = 0;
      const affected = new Set();
      sap.ui.core.BusyIndicator.show(0);
      for (const r of aRequests) {
        try {
          const res = await fetch("/odata/v4/my-services/approveLeaveRequest", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ requestId: r.id, approverId: sApproverId, comments: "" })
          });
          if (!res.ok) { fail++; } else { ok++; if (r.employeeId) affected.add(r.employeeId); }
        } catch (e) { fail++; }
      }
      sap.ui.core.BusyIndicator.hide();
      if (fail === 0) { MessageToast.show(`Successfully approved ${ok} request(s)`); }
      else { MessageBox.warning(`Approved ${ok} request(s).\n${fail} request(s) failed.`); }
      affected.forEach(id => this._bus.publish("leave", "changed", { employeeId: id, source: "manager", change: "approved" }));
      this.onRefresh();
    },

    _rejectMultipleRequests: async function (aRequests, sComments) {
      const sApproverId = this._getApproverId();
      let ok = 0, fail = 0;
      const affected = new Set();
      sap.ui.core.BusyIndicator.show(0);
      for (const r of aRequests) {
        try {
          const res = await fetch("/odata/v4/my-services/rejectLeaveRequest", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ requestId: r.id, approverId: sApproverId, comments: sComments })
          });
          if (!res.ok) { fail++; } else { ok++; if (r.employeeId) affected.add(r.employeeId); }
        } catch (e) { fail++; }
      }
      sap.ui.core.BusyIndicator.hide();
      if (fail === 0) { MessageToast.show(`Successfully rejected ${ok} request(s)`); }
      else { MessageBox.warning(`Rejected ${ok} request(s).\n${fail} request(s) failed.`); }
      affected.forEach(id => this._bus.publish("leave", "changed", { employeeId: id, source: "manager", change: "rejected", comments: sComments }));
      this.onRefresh();
    },

    loadRequestsForEmployee: async function (employeeID) {
      const oViewModel = this.getView().getModel("view");
      if (!employeeID) {
        this._bindTableToOData();
        oViewModel.setProperty("/lastActionEmployeeID", "");
        this._refreshTableBindings();
        return;
      }
      sap.ui.core.BusyIndicator.show(0);
      try {
        const res = await fetch("/odata/v4/my-services/leaveRequests", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ employeeID })
        });
        sap.ui.core.BusyIndicator.hide();
        if (!res.ok) {
          let e = "Failed to load employee requests.";
          try { e = (await res.json())?.error?.message || e; } catch (_) {}
          MessageBox.error(e); return;
        }
        const data = await res.json();
        const requests = data.requests || [];
        this._bindTableToAction(requests);
        oViewModel.setProperty("/lastActionEmployeeID", employeeID);
        MessageToast.show(`Loaded ${Number(data.count || requests.length)} request(s) for employee ${employeeID}`);
      } catch (e) {
        sap.ui.core.BusyIndicator.hide();
        MessageBox.error("Failed to load employee requests.");
      }
    },

    _getApproverId: function () {
      const empId = this.getOwnerComponent()?.getModel("user")?.getProperty("/employeeId");
      return empId || "MANAGER001";
    },

    // LOGOUT 

    onLogout: function () {
      MessageBox.confirm("Are you sure you want to logout?", {
        actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
        emphasizedAction: MessageBox.Action.OK,
        onClose: (sAction) => {
          if (sAction !== MessageBox.Action.OK) return;
          try { sessionStorage.clear(); } catch (e) {}
          try { localStorage.clear(); } catch (e) {}
          if (sap.ushell?.Container) { window.location.hash = "#Shell-home"; return; }
          const oRouter = this.getOwnerComponent?.()?.getRouter?.();
          if (oRouter?.navTo) { oRouter.navTo("Login", {}, true); return; }
          window.location.replace("/login");
        }
      });
    }

  });
});