sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast",
  "sap/m/MessageBox",
  "sap/ui/core/format/DateFormat",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator"
], function (Controller, JSONModel, MessageToast, MessageBox, DateFormat, Filter, FilterOperator) {
  "use strict";

  return Controller.extend("lmsui5.controller.Manager", {

    // ==================== INITIALIZATION ====================

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
        busy: true,
        dataLoaded: false,
        useActionFeed: false,
        lastActionEmployeeID: ""
      });
      
      this.getView().setModel(oViewModel, "view");
      this.byId("selStatus")?.setSelectedKey("Pending");

      const oModel = this.getView().getModel();
      if (oModel && oModel.setSizeLimit) {
        oModel.setSizeLimit(10000);
      }

      this._bus = sap.ui.getCore().getEventBus();

      this._loadLeaveTypes();
    },

    onExit: function () {
    },

    // ==================== LOOKUP LOADERS ====================

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
        if (oBinding?.refresh) {
          oBinding.refresh(true);
        }
      } catch (e) {
        console.warn("Could not refresh bindings:", e.message);
      }
    },

    // ==================== FORMATTERS ====================

    formatLeaveTypeDesc: function (code) {
      if (!code) return "";
      try {
        const oViewModel = this.getView()?.getModel("view");
        if (!oViewModel) return String(code);
        const dataLoaded = oViewModel.getProperty("/dataLoaded");
        if (!dataLoaded) return String(code);
        const map = oViewModel.getProperty("/leaveTypeDescByCode") || {};
        const key = String(code).trim().toUpperCase();
        return map[key] || code;
      } catch (e) {
        console.error("Error in formatLeaveTypeDesc:", e);
        return String(code);
      }
    },

    formatLeaveTypeFullDesc: function (code) {
      if (!code) return "";
      try {
        const oViewModel = this.getView()?.getModel("view");
        if (!oViewModel) return String(code);
        const dataLoaded = oViewModel.getProperty("/dataLoaded");
        if (!dataLoaded) return String(code);
        const map = oViewModel.getProperty("/leaveTypeFullDescByCode") || {};
        const key = String(code).trim().toUpperCase();
        return map[key] || code;
      } catch (e) {
        console.error("Error in formatLeaveTypeFullDesc:", e);
        return String(code);
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
        console.error("Error in formatDateRange:", e);
        return `${sStart || ""} → ${sEnd || ""}`;
      }
    },

    formatDateTime: function (sDateTime) {
      if (!sDateTime) return "";
      try {
        const fmt = DateFormat.getDateTimeInstance({ style: "medium" });
        return fmt.format(new Date(sDateTime));
      } catch (e) {
        console.error("Error in formatDateTime:", e);
        return sDateTime;
      }
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

    // ==================== TABLE EVENTS ====================

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
      const oTable = this.byId("tblRequests");
      const aItems = oTable?.getItems() || [];
      const oViewModel = this.getView().getModel("view");

      let pending = 0;
      let approvedToday = 0;
      let rejectedToday = 0;

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      aItems.forEach(item => {
        const ctx = item.getBindingContext();
        const obj = ctx?.getObject();
        if (!obj) return;

        const status = (obj.status || "").toLowerCase();
        if (status === "pending") {
          pending++;
        } else if (status === "approved" && obj.approvedAt) {
          const approvedDate = new Date(obj.approvedAt);
          approvedDate.setHours(0, 0, 0, 0);
          if (approvedDate.getTime() === today.getTime()) approvedToday++;
        } else if (status === "rejected" && obj.approvedAt) {
          const rejectedDate = new Date(obj.approvedAt);
          rejectedDate.setHours(0, 0, 0, 0);
          if (rejectedDate.getTime() === today.getTime()) rejectedToday++;
        }
      });

      oViewModel.setProperty("/kpi/pending", pending);
      oViewModel.setProperty("/kpi/approvedToday", approvedToday);
      oViewModel.setProperty("/kpi/rejectedToday", rejectedToday);
    },

    onSelectionChange: function () {
      const oTable = this.byId("tblRequests");
      const bHasSelection = (oTable?.getSelectedItems()?.length || 0) > 0;
      this.byId("btnApproveSel")?.setEnabled(bHasSelection);
      this.byId("btnRejectSel")?.setEnabled(bHasSelection);
    },

    onRowPress: function (oEvent) {
      const ctx = oEvent.getSource().getBindingContext();
      const oPopover = this.byId("popDetails");
      if (oPopover && ctx) {
        oPopover.setBindingContext(ctx);
        oPopover.openBy(oEvent.getSource());
      }
    },

    // ==================== FILTERS & SEARCH ====================

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
      const oDR = this.byId("drSubmitted");
      if (oDR) {
        oDR.setDateValue(null);
        oDR.setSecondDateValue(null);
      }
      this.byId("reqSearch")?.setValue("");
      this.loadRequestsForEmployee("");
      this._applyFilters();
    },

    onRefresh: function () {
      const oTable = this.byId("tblRequests");
      const oBinding = oTable?.getBinding("items");
      const oViewModel = this.getView().getModel("view");
      const useAction = !!oViewModel.getProperty("/useActionFeed");

      if (useAction) {
        const lastEmp = oViewModel.getProperty("/lastActionEmployeeID");
        if (lastEmp) {
          this.loadRequestsForEmployee(lastEmp);
          return;
        }
      }

      if (oBinding?.refresh) {
        oBinding.refresh();
      }
      MessageToast.show("Leaves Rejected");
    },

    _applyFilters: function () {
      const oBinding = this.byId("tblRequests")?.getBinding("items");
      if (!oBinding) return;

      const oViewModel = this.getView().getModel("view");
      const useAction = !!oViewModel.getProperty("/useActionFeed");
      const aFilters = [];

      const sStatus = this.byId("selStatus")?.getSelectedKey();
      if (sStatus && sStatus !== "All") {
        aFilters.push(new Filter("status", FilterOperator.EQ, sStatus));
      }

      const oDR = this.byId("drSubmitted");
      if (oDR?.getDateValue() && oDR?.getSecondDateValue()) {
        const dFrom = oDR.getDateValue();
        const dTo = oDR.getSecondDateValue();
        aFilters.push(new Filter({
          filters: [
            new Filter("submittedAt", FilterOperator.GE, dFrom),
            new Filter("submittedAt", FilterOperator.LE, dTo)
          ],
          and: true
        }));
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

    // ==================== ACTION FEED HELPERS ====================

    _bindTableToAction: function (aRequests) {
      const oTable = this.byId("tblRequests");
      if (!oTable) return;

      const oActionModel = new JSONModel({ requests: aRequests || [] });
      this.getView().setModel(oActionModel, "action");

      const oInfo = oTable.getBindingInfo("items");
      const oTemplate = oInfo?.template?.clone();

      oTable.unbindItems();
      oTable.bindItems({
        path: "action>/requests",
        template: oTemplate
      });

      const oViewModel = this.getView().getModel("view");
      oViewModel.setProperty("/useActionFeed", true);
      this._applyFilters();
    },

    _bindTableToOData: function () {
      const oTable = this.byId("tblRequests");
      if (!oTable) return;

      const oInfo = oTable.getBindingInfo("items");
      const oTemplate = oInfo?.template?.clone();

      oTable.unbindItems();
      oTable.bindItems({
        path: "/LeaveRequests",
        template: oTemplate,
        parameters: { $count: true }
      });

      const oViewModel = this.getView().getModel("view");
      oViewModel.setProperty("/useActionFeed", false);
    },

    loadRequestsForEmployee: function (employeeID) {
      const oModel = this.getView().getModel();
      const oViewModel = this.getView().getModel("view");

      if (!employeeID) {
        this._bindTableToOData();
        oViewModel.setProperty("/lastActionEmployeeID", "");
        this._refreshTableBindings();
        return;
      }

      if (!oModel?.callFunction) {
        MessageBox.error("OData action call not available on model.");
        return;
      }

      sap.ui.core.BusyIndicator.show(0);

      oModel.callFunction("/leaveRequests", {
        method: "POST",
        urlParameters: { employeeID },
        success: (data) => {
          sap.ui.core.BusyIndicator.hide();
          const payload = data || {};
          const requests = payload.requests || [];
          const count = Number(payload.count || requests.length || 0);

          this._bindTableToAction(requests);
          oViewModel.setProperty("/lastActionEmployeeID", employeeID);
          MessageToast.show(`Loaded ${count} request(s) for employee ${employeeID}`);
        },
        error: (oError) => {
          sap.ui.core.BusyIndicator.hide();
          console.error("leaveRequests action failed:", oError);
          let errorMessage = "Failed to load employee requests.";
          try {
            const errResponse = JSON.parse(oError.responseText);
            errorMessage = errResponse?.error?.message || errorMessage;
          } catch (e) {}
          MessageBox.error(errorMessage);
        }
      });
    },

    // ==================== ROW ACTIONS ====================

   onApproveOne: function (oEvent) {
  const oSource = oEvent.getSource();
  const oViewModel = this.getView().getModel("view");
  const useAction = !!oViewModel.getProperty("/useActionFeed");

  // ✅ FIX: Use correct binding context based on current table mode
  const ctx = useAction
    ? oSource.getBindingContext("action")
    : oSource.getBindingContext();

  const oData = ctx?.getObject();

  console.log("onApproveOne oData:", oData, "useAction:", useAction);

  if (!oData) {
    MessageBox.error("Could not read request data. Please refresh.");
    return;
  }

  const sEmployeeName = oData.empname || oData.employee_employeeId || "Unknown";
  MessageBox.confirm(`Approve leave request for ${sEmployeeName}?`, {
    onClose: (sAction) => {
      if (sAction === MessageBox.Action.OK) {
        const sEmpId = oData.employee_employeeId || oData.employeeId || "";
        this._approveRequest(oData.ID || oData.id, sEmpId);
      }
    }
  });
},

onRejectOne: function (oEvent) {
  const oSource = oEvent.getSource();
  const oViewModel = this.getView().getModel("view");
  const useAction = !!oViewModel.getProperty("/useActionFeed");

  // ✅ FIX: Use correct binding context based on current table mode
  const ctx = useAction
    ? oSource.getBindingContext("action")
    : oSource.getBindingContext();

  const oData = ctx?.getObject();

  console.log("onRejectOne oData:", oData, "useAction:", useAction);

  if (!oData) {
    MessageBox.error("Could not read request data. Please refresh.");
    return;
  }
  this._openRejectDialog(oData);
},

    onApproveFromPopover: function () {
      const oPopover = this.byId("popDetails");
      const ctx = oPopover?.getBindingContext();
      const oData = ctx?.getObject();
      if (!oData) return;

      const sEmployeeName = oData.empname || oData.employee_employeeId || "Unknown";

      MessageBox.confirm(`Approve leave request for ${sEmployeeName}?`, {
        onClose: (sAction) => {
          if (sAction === MessageBox.Action.OK) {
            const sEmpId = oData.employee_employeeId || oData.employeeId || "";
            this._approveRequest(oData.ID || oData.id, sEmpId);
            oPopover.close();
          }
        }
      });
    },

  onRejectFromPopover: function () {
  const oPopover = this.byId("popDetails");
  // Popover context is always set via setBindingContext() directly, 
  // so no model name needed here
  const ctx = oPopover?.getBindingContext() || oPopover?.getBindingContext("action");
  const oData = ctx?.getObject();

  console.log("onRejectFromPopover oData:", oData);

  if (!oData) return;
  oPopover.close();
  this._openRejectDialog(oData);
},

    onApproveSelected: function () {
      const oTable = this.byId("tblRequests");
      const aSelectedItems = oTable?.getSelectedItems() || [];
      if (aSelectedItems.length === 0) {
        MessageToast.show("Please select at least one request");
        return;
      }

      // capture employeeId per request for EventBus
      const aRequests = aSelectedItems.map(item => {
        const ctx = item.getBindingContext();
        const obj = ctx.getObject();
        return {
          id: obj.ID || obj.id,
          employeeId: obj.employee_employeeId || obj.employeeId || ""
        };
      });

      MessageBox.confirm(`Approve ${aRequests.length} leave request(s)?`, {
        onClose: (sAction) => {
          if (sAction === MessageBox.Action.OK) {
            this._approveMultipleRequests(aRequests);
          }
        }
      });
    },

    onRejectSelected: function () {
      const oTable = this.byId("tblRequests");
      const aSelectedItems = oTable?.getSelectedItems() || [];
      if (aSelectedItems.length === 0) {
        MessageToast.show("Please select at least one request");
        return;
      }

      // capture employeeId per request
      const aRequests = aSelectedItems.map(item => {
        const ctx = item.getBindingContext();
        const oData = ctx.getObject();
        return {
          id: oData.ID || oData.id,
          empname: oData.empname || oData.employee_employeeId || "Unknown",
          leaveType: oData.leaveType || this.formatLeaveTypeFullDesc(oData.leaveType_code),
          employeeId: oData.employee_employeeId || oData.employeeId || ""
        };
      });

      this._openBulkRejectDialog(aRequests);
    },

    // ==================== REJECT DIALOG ====================
_openRejectDialog: function (oData) {
  const oViewModel = this.getView().getModel("view");
  const empName = oData.empname || oData.employee_employeeId || "Unknown";
  const ltFull = oData.leaveType || this.formatLeaveTypeFullDesc(oData.leaveType_code);

  // ✅ FIX: Try all possible ID field variants
  const sRequestId = oData.ID || oData.id || oData.requestId || "";

  console.log("Opening reject dialog, resolved requestId:", sRequestId, "from oData:", oData);

  if (!sRequestId) {
    MessageBox.error("Could not resolve request ID. Please refresh and try again.");
    return;
  }

  oViewModel.setProperty("/rejectData/employeeName", empName);
  oViewModel.setProperty("/rejectData/leaveType", ltFull);
  oViewModel.setProperty("/rejectData/comments", "");
  oViewModel.setProperty("/rejectData/commentLength", 0);
  oViewModel.setProperty("/rejectData/requestId", sRequestId);
  oViewModel.setProperty("/rejectData/isBulk", false);
  oViewModel.setProperty("/rejectData/employeeId", oData.employee_employeeId || oData.employeeId || "");

  this.byId("rejectCommentDialog")?.open();
},

    _openBulkRejectDialog: function (aRequests) {
      const oViewModel = this.getView().getModel("view");

      oViewModel.setProperty("/rejectData/employeeName", `${aRequests.length} employees`);
      oViewModel.setProperty("/rejectData/leaveType", "Multiple requests");
      oViewModel.setProperty("/rejectData/comments", "");
      oViewModel.setProperty("/rejectData/commentLength", 0);
      oViewModel.setProperty("/rejectData/bulkRequests", aRequests);
      oViewModel.setProperty("/rejectData/isBulk", true);
      oViewModel.setProperty("/rejectData/employeeId", "");   // clear single employeeId for bulk

      this.byId("rejectCommentDialog")?.open();
    },

    onCommentChange: function (oEvent) {
      const sValue = oEvent.getParameter("value") || "";
      this.getView().getModel("view").setProperty("/rejectData/commentLength", sValue.length);
    },

    onConfirmReject: function () {
      const oViewModel = this.getView().getModel("view");
      const oRejectData = oViewModel.getProperty("/rejectData");

      if (!oRejectData.comments || !oRejectData.comments.trim()) {
        MessageToast.show("Please enter rejection comments");
        return;
      }

      if (oRejectData.isBulk) {
        this._rejectMultipleRequests(oRejectData.bulkRequests, oRejectData.comments);
      } else {
        // pass employeeId through to _rejectRequest
        this._rejectRequest(oRejectData.requestId, oRejectData.comments, oRejectData.employeeId);
      }

      this.byId("rejectCommentDialog")?.close();
    },

    onCancelReject: function () {
      this.byId("rejectCommentDialog")?.close();
    },



// ==================== BACKEND CALLS ====================

/**
 * Approve a leave request — uses fetch (V4 compatible)
 */
_approveRequest: async function (sRequestId, sEmployeeId) {
  const sApproverId = this._getApproverId();

  sap.ui.core.BusyIndicator.show(0);

  try {
    const res = await fetch("/odata/v4/my-services/approveLeaveRequest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: sRequestId,
        approverId: sApproverId,
        comments: ""
      })
    });

    sap.ui.core.BusyIndicator.hide();

    if (!res.ok) {
      let errMsg = "Failed to approve leave request.";
      try { errMsg = (await res.json())?.error?.message || errMsg; } catch (e) {}
      MessageBox.error(errMsg);
      return;
    }

    MessageToast.show("Leave request approved successfully");

    //  Employee view refreshes
    this._bus.publish("leave", "changed", {
      employeeId: sEmployeeId || "",
      source: "manager",
      change: "approved",
      requestId: sRequestId
    });

    this.onRefresh();

  } catch (e) {
    sap.ui.core.BusyIndicator.hide();
    console.error("Approve error:", e);
    MessageBox.error("Failed to approve leave request.");
  }
},

/**
 * Reject a leave request 
 */
_rejectRequest: async function (sRequestId, sComments, sEmployeeId) {
  const sApproverId = this._getApproverId();

  sap.ui.core.BusyIndicator.show(0);

  try {
    const res = await fetch("/odata/v4/my-services/rejectLeaveRequest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: sRequestId,
        approverId: sApproverId,
        comments: sComments
      })
    });

    sap.ui.core.BusyIndicator.hide();

    if (!res.ok) {
      let errMsg = "Failed to reject leave request.";
      try { errMsg = (await res.json())?.error?.message || errMsg; } catch (e) {}
      MessageBox.error(errMsg);
      return;
    }

    MessageToast.show("Leave request rejected successfully");

    //Employee view refreshes
    this._bus.publish("leave", "changed", {
      employeeId: sEmployeeId || "",
      source: "manager",
      change: "rejected",
      requestId: sRequestId,
      comments: sComments
    });

    this.onRefresh();

  } catch (e) {
    sap.ui.core.BusyIndicator.hide();
    console.error("Reject error:", e);
    MessageBox.error("Failed to reject leave request.");
  }
},

/**
 * Approve multiple requests 
 */
_approveMultipleRequests: async function (aRequests) {
  const sApproverId = this._getApproverId();
  let successCount = 0;
  let errorCount = 0;
  const affectedEmployeeIds = new Set();

  sap.ui.core.BusyIndicator.show(0);

  for (const request of aRequests) {
    try {
      const res = await fetch("/odata/v4/my-services/approveLeaveRequest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: request.id,
          approverId: sApproverId,
          comments: ""
        })
      });

      if (!res.ok) {
        errorCount++;
        console.error(`Failed to approve request ${request.id}:`, await res.text());
      } else {
        successCount++;
        if (request.employeeId) affectedEmployeeIds.add(request.employeeId);
      }
    } catch (e) {
      errorCount++;
      console.error(`Error approving request ${request.id}:`, e);
    }
  }

  sap.ui.core.BusyIndicator.hide();

  if (errorCount === 0) {
    MessageToast.show(`Successfully approved ${successCount} request(s)`);
  } else {
    MessageBox.warning(`Approved ${successCount} request(s).\n${errorCount} request(s) failed.`);
  }

  // Publish one event per affected employee
  affectedEmployeeIds.forEach(empId => {
    this._bus.publish("leave", "changed", {
      employeeId: empId,
      source: "manager",
      change: "approved"
    });
  });

  this.onRefresh();
},

/**
 * Reject multiple requests 
 */
_rejectMultipleRequests: async function (aRequests, sComments) {
  const sApproverId = this._getApproverId();
  let successCount = 0;
  let errorCount = 0;
  const affectedEmployeeIds = new Set();

  sap.ui.core.BusyIndicator.show(0);

  for (const request of aRequests) {
    try {
      const res = await fetch("/odata/v4/my-services/rejectLeaveRequest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: request.id,
          approverId: sApproverId,
          comments: sComments
        })
      });

      if (!res.ok) {
        errorCount++;
        console.error(`Failed to reject request ${request.id}:`, await res.text());
      } else {
        successCount++;
        if (request.employeeId) affectedEmployeeIds.add(request.employeeId);
      }
    } catch (e) {
      errorCount++;
      console.error(`Error rejecting request ${request.id}:`, e);
    }
  }

  sap.ui.core.BusyIndicator.hide();

  if (errorCount === 0) {
    MessageToast.show(`Successfully rejected ${successCount} request(s)`);
  } else {
    MessageBox.warning(`Rejected ${successCount} request(s).\n${errorCount} request(s) failed.`);
  }

  // Publish one event per affected employee
  affectedEmployeeIds.forEach(empId => {
    this._bus.publish("leave", "changed", {
      employeeId: empId,
      source: "manager",
      change: "rejected",
      comments: sComments
    });
  });

  this.onRefresh();
},

/**
 * Also fix loadRequestsForEmployee to use fetch
 */
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
      let errMsg = "Failed to load employee requests.";
      try { errMsg = (await res.json())?.error?.message || errMsg; } catch (e) {}
      MessageBox.error(errMsg);
      return;
    }

    const data = await res.json();
    const requests = data.requests || [];
    const count = Number(data.count || requests.length || 0);

    this._bindTableToAction(requests);
    oViewModel.setProperty("/lastActionEmployeeID", employeeID);
    MessageToast.show(`Loaded ${count} request(s) for employee ${employeeID}`);

  } catch (e) {
    sap.ui.core.BusyIndicator.hide();
    console.error("leaveRequests fetch failed:", e);
    MessageBox.error("Failed to load employee requests.");
  }
},

/**
 * Helper: get current manager/approver ID from session model
 * Replace "MANAGER001" with real session lookup once available
 */
_getApproverId: function () {
  const oUserModel = this.getOwnerComponent()?.getModel("user");
  const empId = oUserModel?.getProperty("/employeeId");
  return empId || "MANAGER001";
},
    // ==================== LOGOUT ====================

    onLogout: function () {
      MessageBox.confirm("Are you sure you want to logout?", {
        actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
        emphasizedAction: MessageBox.Action.OK,
        onClose: (sAction) => {
          if (sAction !== MessageBox.Action.OK) return;
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
    }

  });
});