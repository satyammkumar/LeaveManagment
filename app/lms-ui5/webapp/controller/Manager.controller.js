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

        // Lookup maps
        leaveTypes: [],
        leaveTypeDescByCode: {},
        leaveTypeFullDescByCode: {},

        // Reject dialog state
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

        // Action feed flags
        useActionFeed: false,
        lastActionEmployeeID: ""
      });
      
      this.getView().setModel(oViewModel, "view");

      // Set default status filter
      this.byId("selStatus")?.setSelectedKey("Pending");

      // Set model size limit
      const oModel = this.getView().getModel();
      if (oModel && oModel.setSizeLimit) {
        oModel.setSizeLimit(10000);
      }

      // Load lookup data
      this._loadLeaveTypes();
    },

    // ==================== LOOKUP LOADERS ====================

    /**
     * Load leave types for dropdown and formatters
     */
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

    /**
     * Refresh table bindings
     */
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

    /**
     * Format leave type code to description
     */
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

    /**
     * Format leave type code to full description (CODE - Description)
     */
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

    /**
     * Format date range
     */
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

    /**
     * Format datetime
     */
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

    /**
     * Format status to semantic state
     */
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

    /**
     * Handle table update finished
     */
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

      // Update KPIs
      this._updateKPIs();
    },

    /**
     * Update KPI counts
     */
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
          if (approvedDate.getTime() === today.getTime()) {
            approvedToday++;
          }
        } else if (status === "rejected" && obj.approvedAt) {
          const rejectedDate = new Date(obj.approvedAt);
          rejectedDate.setHours(0, 0, 0, 0);
          if (rejectedDate.getTime() === today.getTime()) {
            rejectedToday++;
          }
        }
      });

      oViewModel.setProperty("/kpi/pending", pending);
      oViewModel.setProperty("/kpi/approvedToday", approvedToday);
      oViewModel.setProperty("/kpi/rejectedToday", rejectedToday);
    },

    /**
     * Handle selection change
     */
    onSelectionChange: function () {
      const oTable = this.byId("tblRequests");
      const bHasSelection = (oTable?.getSelectedItems()?.length || 0) > 0;
      this.byId("btnApproveSel")?.setEnabled(bHasSelection);
      this.byId("btnRejectSel")?.setEnabled(bHasSelection);
    },

    /**
     * Handle row press - open details popover
     */
    onRowPress: function (oEvent) {
      const ctx = oEvent.getSource().getBindingContext();
      const oPopover = this.byId("popDetails");
      if (oPopover && ctx) {
        oPopover.setBindingContext(ctx);
        oPopover.openBy(oEvent.getSource());
      }
    },

    // ==================== FILTERS & SEARCH ====================

    onStatusChange: function () { 
      this._applyFilters(); 
    },

    onDateRangeChange: function () { 
      this._applyFilters(); 
    },

    onLiveSearch: function () { 
      this._applyFilters(); 
    },

    /**
     * Handle search - detect employee ID and load specific employee
     */
    onSearch: function () {
      const s = (this.byId("reqSearch")?.getValue() || "").trim();

      // Check if this looks like an employee ID (adjust regex as needed)
      const isEmployeeID = /^[A-Za-z]{2,}\d{2,}$|^\d{3,}$/.test(s);

      if (isEmployeeID) {
        // Load requests for specific employee
        this.loadRequestsForEmployee(s);
      } else if (!s) {
        // Clear search - return to OData
        this.loadRequestsForEmployee("");
      } else {
        // General search - use filters
        this._applyFilters();
      }
    },

    /**
     * Clear all filters
     */
    onClearFilters: function () {
      this.byId("selStatus")?.setSelectedKey("All");
      const oDR = this.byId("drSubmitted");
      if (oDR) {
        oDR.setDateValue(null);
        oDR.setSecondDateValue(null);
      }
      this.byId("reqSearch")?.setValue("");

      // Return to OData binding
      this.loadRequestsForEmployee("");
      this._applyFilters();
    },

    /**
     * Refresh data
     */
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
      MessageToast.show("Data refreshed");
    },

    /**
     * Apply filters to table
     */
    _applyFilters: function () {
      const oBinding = this.byId("tblRequests")?.getBinding("items");
      if (!oBinding) return;

      const oViewModel = this.getView().getModel("view");
      const useAction = !!oViewModel.getProperty("/useActionFeed");

      const aFilters = [];

      // Status filter
      const sStatus = this.byId("selStatus")?.getSelectedKey();
      if (sStatus && sStatus !== "All") {
        aFilters.push(new Filter("status", FilterOperator.EQ, sStatus));
      }

      // Date Range filter
      const oDR = this.byId("drSubmitted");
      if (oDR?.getDateValue() && oDR?.getSecondDateValue()) {
        const dFrom = oDR.getDateValue();
        const dTo = oDR.getSecondDateValue();
        aFilters.push(
          new Filter({
            filters: [
              new Filter("submittedAt", FilterOperator.GE, dFrom),
              new Filter("submittedAt", FilterOperator.LE, dTo)
            ],
            and: true
          })
        );
      }

      // Search filter
      const q = this.byId("reqSearch")?.getValue();
      if (q && q.trim()) {
        if (useAction) {
          // Action payload fields
          aFilters.push(
            new Filter({
              filters: [
                new Filter("empname", FilterOperator.Contains, q),
                new Filter("leaveType", FilterOperator.Contains, q),
                new Filter("reason", FilterOperator.Contains, q)
              ],
              and: false
            })
          );
        } else {
          // OData entity fields
          aFilters.push(
            new Filter({
              filters: [
                new Filter("empname", FilterOperator.Contains, q),
                new Filter("employee_employeeId", FilterOperator.Contains, q),
                new Filter("leaveType_code", FilterOperator.Contains, q),
                new Filter("reason", FilterOperator.Contains, q)
              ],
              and: false
            })
          );
        }
      }

      oBinding.filter(aFilters);
    },

    // ==================== ACTION FEED HELPERS ====================

    /**
     * Bind table to action results
     */
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

    /**
     * Bind table back to OData
     */
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

    /**
     * Load requests for a specific employee via Action
     * @param {string} employeeID - Employee ID or empty string to return to OData
     */
    loadRequestsForEmployee: function (employeeID) {
      const oModel = this.getView().getModel();
      const oViewModel = this.getView().getModel("view");

      if (!employeeID) {
        // Switch back to OData binding
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

          // Bind table to action results
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
          } catch (e) {
            // Use default message
          }

          MessageBox.error(errorMessage);
        }
      });
    },

    // ==================== ROW ACTIONS ====================

    /**
     * Approve single request from table row
     */
    onApproveOne: function (oEvent) {
      const ctx = oEvent.getSource().getBindingContext();
      const oData = ctx?.getObject();
      if (!oData) return;

      const sEmployeeName = oData.empname || oData.employee_employeeId || "Unknown";

      MessageBox.confirm(`Approve leave request for ${sEmployeeName}?`, {
        onClose: (sAction) => {
          if (sAction === MessageBox.Action.OK) {
            this._approveRequest(oData.ID || oData.id);
          }
        }
      });
    },

    /**
     * Reject single request from table row
     */
    onRejectOne: function (oEvent) {
      const ctx = oEvent.getSource().getBindingContext();
      const oData = ctx?.getObject();
      if (!oData) return;
      this._openRejectDialog(oData);
    },

    /**
     * Approve request from popover
     */
    onApproveFromPopover: function () {
      const oPopover = this.byId("popDetails");
      const ctx = oPopover?.getBindingContext();
      const oData = ctx?.getObject();
      if (!oData) return;

      const sEmployeeName = oData.empname || oData.employee_employeeId || "Unknown";

      MessageBox.confirm(`Approve leave request for ${sEmployeeName}?`, {
        onClose: (sAction) => {
          if (sAction === MessageBox.Action.OK) {
            this._approveRequest(oData.ID || oData.id);
            oPopover.close();
          }
        }
      });
    },

    /**
     * Reject request from popover
     */
    onRejectFromPopover: function () {
      const oPopover = this.byId("popDetails");
      const ctx = oPopover?.getBindingContext();
      const oData = ctx?.getObject();
      if (!oData) return;
      oPopover.close();
      this._openRejectDialog(oData);
    },

    /**
     * Approve selected requests (bulk)
     */
    onApproveSelected: function () {
      const oTable = this.byId("tblRequests");
      const aSelectedItems = oTable?.getSelectedItems() || [];
      if (aSelectedItems.length === 0) {
        MessageToast.show("Please select at least one request");
        return;
      }

      const aRequests = aSelectedItems.map(item => {
        const ctx = item.getBindingContext();
        const obj = ctx.getObject();
        return {
          id: obj.ID || obj.id
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

    /**
     * Reject selected requests (bulk)
     */
    onRejectSelected: function () {
      const oTable = this.byId("tblRequests");
      const aSelectedItems = oTable?.getSelectedItems() || [];
      if (aSelectedItems.length === 0) {
        MessageToast.show("Please select at least one request");
        return;
      }

      const aRequests = aSelectedItems.map(item => {
        const ctx = item.getBindingContext();
        const oData = ctx.getObject();

        const id = oData.ID || oData.id;
        const empname = oData.empname || oData.employee_employeeId || "Unknown";
        const leaveType = oData.leaveType || this.formatLeaveTypeFullDesc(oData.leaveType_code);

        return {
          id,
          empname,
          leaveType
        };
      });

      this._openBulkRejectDialog(aRequests);
    },

    // ==================== REJECT DIALOG ====================

    /**
     * Open reject dialog for single request
     */
    _openRejectDialog: function (oData) {
      const oViewModel = this.getView().getModel("view");
      const empName = oData.empname || oData.employee_employeeId || "Unknown";
      const ltFull = oData.leaveType || this.formatLeaveTypeFullDesc(oData.leaveType_code);

      oViewModel.setProperty("/rejectData/employeeName", empName);
      oViewModel.setProperty("/rejectData/leaveType", ltFull);
      oViewModel.setProperty("/rejectData/comments", "");
      oViewModel.setProperty("/rejectData/commentLength", 0);
      oViewModel.setProperty("/rejectData/requestId", oData.ID || oData.id);
      oViewModel.setProperty("/rejectData/isBulk", false);

      this.byId("rejectCommentDialog")?.open();
    },

    /**
     * Open reject dialog for multiple requests
     */
    _openBulkRejectDialog: function (aRequests) {
      const oViewModel = this.getView().getModel("view");

      oViewModel.setProperty("/rejectData/employeeName", `${aRequests.length} employees`);
      oViewModel.setProperty("/rejectData/leaveType", "Multiple requests");
      oViewModel.setProperty("/rejectData/comments", "");
      oViewModel.setProperty("/rejectData/commentLength", 0);
      oViewModel.setProperty("/rejectData/bulkRequests", aRequests);
      oViewModel.setProperty("/rejectData/isBulk", true);

      this.byId("rejectCommentDialog")?.open();
    },

    /**
     * Handle comment change - update character count
     */
    onCommentChange: function (oEvent) {
      const sValue = oEvent.getParameter("value") || "";
      this.getView().getModel("view").setProperty("/rejectData/commentLength", sValue.length);
    },

    /**
     * Confirm reject
     */
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
        this._rejectRequest(oRejectData.requestId, oRejectData.comments);
      }

      this.byId("rejectCommentDialog")?.close();
    },

    /**
     * Cancel reject
     */
    onCancelReject: function () {
      this.byId("rejectCommentDialog")?.close();
    },

    // ==================== BACKEND CALLS ====================

    /**
     * Approve a leave request
     */
    _approveRequest: function (sRequestId) {
      const oModel = this.getView().getModel();
      const sApproverId = "MANAGER001"; // TODO: Get from session/user model

      const oPayload = {
        requestId: sRequestId,
        approverId: sApproverId,
        comments: ""
      };

      if (oModel?.callFunction) {
        sap.ui.core.BusyIndicator.show(0);

        oModel.callFunction("/approveLeaveRequest", {
          method: "POST",
          urlParameters: oPayload,
          success: () => {
            sap.ui.core.BusyIndicator.hide();
            MessageToast.show("Leave request approved successfully");
            this.onRefresh();
          },
          error: (oError) => {
            sap.ui.core.BusyIndicator.hide();
            console.error("Approve error:", oError);

            let errorMessage = "Failed to approve leave request.";
            try {
              const errResponse = JSON.parse(oError.responseText);
              errorMessage = errResponse?.error?.message || errorMessage;
            } catch (e) {
              // Use default
            }

            MessageBox.error(errorMessage);
          }
        });
      } else {
        MessageBox.information("OData action call not available");
      }
    },

    /**
     * Reject a leave request
     */
    _rejectRequest: function (sRequestId, sComments) {
      const oModel = this.getView().getModel();
      const sApproverId = "MANAGER001"; // TODO: Get from session/user model

      const oPayload = {
        requestId: sRequestId,
        approverId: sApproverId,
        comments: sComments
      };

      if (oModel?.callFunction) {
        sap.ui.core.BusyIndicator.show(0);

        oModel.callFunction("/rejectLeaveRequest", {
          method: "POST",
          urlParameters: oPayload,
          success: () => {
            sap.ui.core.BusyIndicator.hide();
            MessageToast.show("Leave request rejected successfully");
            this.onRefresh();
          },
          error: (oError) => {
            sap.ui.core.BusyIndicator.hide();
            console.error("Reject error:", oError);

            let errorMessage = "Failed to reject leave request.";
            try {
              const errResponse = JSON.parse(oError.responseText);
              errorMessage = errResponse?.error?.message || errorMessage;
            } catch (e) {
              // Use default
            }

            MessageBox.error(errorMessage);
          }
        });
      } else {
        MessageBox.information("OData action call not available");
      }
    },

    // ==================== BULK OPERATIONS ====================

    /**
     * Approve multiple requests
     */
    _approveMultipleRequests: function (aRequests) {
      const oModel = this.getView().getModel();
      const sApproverId = "MANAGER001"; // TODO: Get from session

      let successCount = 0;
      let errorCount = 0;

      sap.ui.core.BusyIndicator.show(0);

      const processNext = (index) => {
        if (index >= aRequests.length) {
          sap.ui.core.BusyIndicator.hide();

          if (errorCount === 0) {
            MessageToast.show(`Successfully approved ${successCount} request(s)`);
          } else {
            MessageBox.warning(
              `Approved ${successCount} request(s).\n${errorCount} request(s) failed.`
            );
          }

          this.onRefresh();
          return;
        }

        const request = aRequests[index];
        const oPayload = {
          requestId: request.id,
          approverId: sApproverId,
          comments: ""
        };

        if (oModel?.callFunction) {
          oModel.callFunction("/approveLeaveRequest", {
            method: "POST",
            urlParameters: oPayload,
            success: () => {
              successCount++;
              processNext(index + 1);
            },
            error: (oError) => {
              errorCount++;
              console.error(`Failed to approve request ${request.id}:`, oError);
              processNext(index + 1);
            }
          });
        } else {
          sap.ui.core.BusyIndicator.hide();
          MessageBox.information("OData action call not available");
        }
      };

      processNext(0);
    },

    /**
     * Reject multiple requests
     */
    _rejectMultipleRequests: function (aRequests, sComments) {
      const oModel = this.getView().getModel();
      const sApproverId = "MANAGER001"; // TODO: Get from session

      let successCount = 0;
      let errorCount = 0;

      sap.ui.core.BusyIndicator.show(0);

      const processNext = (index) => {
        if (index >= aRequests.length) {
          sap.ui.core.BusyIndicator.hide();

          if (errorCount === 0) {
            MessageToast.show(`Successfully rejected ${successCount} request(s)`);
          } else {
            MessageBox.warning(
              `Rejected ${successCount} request(s).\n${errorCount} request(s) failed.`
            );
          }

          this.onRefresh();
          return;
        }

        const request = aRequests[index];
        const oPayload = {
          requestId: request.id,
          approverId: sApproverId,
          comments: sComments
        };

        if (oModel?.callFunction) {
          oModel.callFunction("/rejectLeaveRequest", {
            method: "POST",
            urlParameters: oPayload,
            success: () => {
              successCount++;
              processNext(index + 1);
            },
            error: (oError) => {
              errorCount++;
              console.error(`Failed to reject request ${request.id}:`, oError);
              processNext(index + 1);
            }
          });
        } else {
          sap.ui.core.BusyIndicator.hide();
          MessageBox.information("OData action call not available");
        }
      };

      processNext(0);
    },

    // ==================== LOGOUT ====================

    /**
     * Handle logout
     */
    onLogout: function () {
      MessageBox.confirm("Are you sure you want to logout?", {
        actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
        emphasizedAction: MessageBox.Action.OK,
        onClose: (sAction) => {
          if (sAction !== MessageBox.Action.OK) return;

          try {
            sessionStorage.clear();
          } catch (e) {
            console.error("Error clearing session storage:", e);
          }
          try {
            localStorage.clear();
          } catch (e) {
            console.error("Error clearing local storage:", e);
          }

          // Handle Fiori Launchpad
          if (sap.ushell?.Container) {
            window.location.hash = "#Shell-home";
            return;
          }

          // Handle standalone app with router
          const oComp = this.getOwnerComponent?.();
          const oRouter = oComp?.getRouter?.();
          if (oRouter?.navTo) {
            oRouter.navTo("Login", {}, true);
            return;
          }

          // Fallback
          window.location.replace("/login");
        }
      });
    }

  });
});