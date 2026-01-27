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

    onInit: function () {
      const oViewModel = new JSONModel({
        kpi: { pending: 0, approvedToday: 0, rejectedToday: 0 },
        counts: { leaveRequests: "" },

        // Lookup
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
          employeeId: ""
        },

        busy: true,
        dataLoaded: false,

        // === New flags for action feed ===
        useActionFeed: false,
        lastActionEmployeeID: ""
      });
      this.getView().setModel(oViewModel, "view");

      this.byId("selStatus")?.setSelectedKey("Pending");

      const oModel = this.getView().getModel();
      if (oModel && oModel.setSizeLimit) {
        oModel.setSizeLimit(10000);
      }

      // Load lookups
      this._loadLeaveTypes();
    },

    /* ========= LOOKUP LOADERS ========= */

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

    /* ========= FORMATTERS ========= */

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
      }
      return String(code);
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
      }
      return String(code);
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

    /* ========= TABLE & EVENTS ========= */

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

      try {
        const aItems = oTable.getItems();
        if (aItems.length > 0) {
          const obj = aItems[0].getBindingContext()?.getObject();
          // Debug
          // console.log("First row:", obj);
        }
      } catch (e) {
        console.error("Error in onUpdateFinished debug:", e);
      }
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

    /* ========= FILTERS & SEARCH ========= */

    onStatusChange: function () { this._applyFilters(); },
    onDateRangeChange: function () { this._applyFilters(); },

    // Enhanced onSearch:
    // If the query looks like an employeeID, we load via Action; if cleared, return to OData.
    onLiveSearch: function () { this._applyFilters(); },
    onSearch: function () {
      const s = (this.byId("reqSearch")?.getValue() || "").trim();

      // Adjust this regex to your employee ID pattern
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
      this._applyFilters();
      // Also switch back to OData on clear
      this.loadRequestsForEmployee("");
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
      MessageToast.show("Data refreshed");
    },

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
                new Filter("empname",  FilterOperator.Contains, q),
                new Filter("leaveType", FilterOperator.Contains, q),
                new Filter("reason",   FilterOperator.Contains, q)
              ],
              and: false
            })
          );
        } else {
          // OData entity fields
          aFilters.push(
            new Filter({
              filters: [
                new Filter("empname",               FilterOperator.Contains, q),
                new Filter("employee_employeeId",   FilterOperator.Contains, q),
                new Filter("leaveType_code",        FilterOperator.Contains, q),
                new Filter("reason",                FilterOperator.Contains, q)
              ],
              and: false
            })
          );
        }
      }

      oBinding.filter(aFilters);
    },

    /* ========= ACTION FEED HELPERS (NEW) ========= */

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
        template: oTemplate
      });

      const oViewModel = this.getView().getModel("view");
      oViewModel.setProperty("/useActionFeed", false);
    },

    /**
     * Load requests for a specific employee via Action and show in the same table.
     * Pass employeeID (string). If empty, switch back to OData table.
     */
    loadRequestsForEmployee: function (employeeID) {
      const oModel = this.getView().getModel();
      const oViewModel = this.getView().getModel("view");

      if (!employeeID) {
        this._bindTableToOData();
        oViewModel.setProperty("/lastActionEmployeeID", "");
        return;
      }

      if (!oModel?.callFunction) {
        MessageBox.error("OData action call not available on model.");
        return;
      }

      sap.ui.core.BusyIndicator.show(0);

      oModel.callFunction("/getEmployeeLeaveRequests", {
        method: "POST",
        urlParameters: { employeeID },
        success: (data) => {
          sap.ui.core.BusyIndicator.hide();

          const payload = data || {};
          const requests = payload.requests || payload.value?.requests || [];

          this._bindTableToAction(requests);
          oViewModel.setProperty("/lastActionEmployeeID", employeeID);

          const count = Number(payload.count || requests.length || 0);
          MessageToast.show(`Loaded ${count} request(s) for ${employeeID}`);
        },
        error: (oError) => {
          sap.ui.core.BusyIndicator.hide();
          console.error("getEmployeeLeaveRequests failed:", oError);
          MessageBox.error("Failed to load employee requests.");
        }
      });
    },

    /* ========= ROW ACTIONS ========= */

    onApproveOne: function (oEvent) {
      const ctx = oEvent.getSource().getBindingContext();
      const oData = ctx?.getObject();
      if (!oData) return;

      const sEmployeeName = (oData.empname || "").trim() || oData.employee_employeeId || "";
      MessageBox.confirm(`Approve leave request for ${sEmployeeName}?`, {
        onClose: (sAction) => {
          if (sAction === MessageBox.Action.OK) {
            this._approveRequest(oData.ID || oData.id, "");
          }
        }
      });
    },

    onRejectOne: function (oEvent) {
      const ctx = oEvent.getSource().getBindingContext();
      const oData = ctx?.getObject();
      if (!oData) return;
      this._openRejectDialog(oData);
    },

    onApproveFromPopover: function () {
      const oPopover = this.byId("popDetails");
      const ctx = oPopover?.getBindingContext();
      const oData = ctx?.getObject();
      if (!oData) return;

      const sEmployeeName = (oData.empname || "").trim() || oData.employee_employeeId || "";
      MessageBox.confirm(`Approve leave request for ${sEmployeeName}?`, {
        onClose: (sAction) => {
          if (sAction === MessageBox.Action.OK) {
            this._approveRequest(oData.ID || oData.id, "");
            oPopover.close();
          }
        }
      });
    },

    onRejectFromPopover: function () {
      const oPopover = this.byId("popDetails");
      const ctx = oPopover?.getBindingContext();
      const oData = ctx?.getObject();
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

      const aRequests = aSelectedItems.map(item => {
        const ctx = item.getBindingContext();
        const obj = ctx.getObject();
        return {
          id: obj.ID || obj.id,
          employeeId: obj.employee_employeeId || ""
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

      const useAction = !!this.getView().getModel("view").getProperty("/useActionFeed");

      const aRequests = aSelectedItems.map(item => {
        const ctx = item.getBindingContext();
        const oData = ctx.getObject();

        const id = oData.ID || oData.id;
        const empname = (oData.empname || "").trim() || oData.employee_employeeId || "";
        const leaveTypePretty = useAction
          ? (oData.leaveType || "")
          : this.formatLeaveTypeFullDesc(oData.leaveType_code);

        return {
          id,
          employeeId: oData.employee_employeeId || "",
          empname,
          leaveType: leaveTypePretty
        };
      });

      this._openBulkRejectDialog(aRequests);
    },

    /* ========= REJECT DIALOG ========= */

    _openRejectDialog: function (oData) {
      const oViewModel = this.getView().getModel("view");
      const empName = (oData.empname || "").trim() || oData.employee_employeeId || "";
      const ltFull = oData.leaveType || this.formatLeaveTypeFullDesc(oData.leaveType_code);

      oViewModel.setProperty("/rejectData/employeeName", empName);
      oViewModel.setProperty("/rejectData/leaveType", ltFull);
      oViewModel.setProperty("/rejectData/comments", "");
      oViewModel.setProperty("/rejectData/commentLength", 0);
      oViewModel.setProperty("/rejectData/requestId", oData.ID || oData.id);
      oViewModel.setProperty("/rejectData/employeeId", oData.employee_employeeId || "");
      oViewModel.setProperty("/rejectData/isBulk", false);

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
        this._rejectRequest(oRejectData.requestId, oRejectData.employeeId, oRejectData.comments);
      }

      this.byId("rejectCommentDialog")?.close();
    },

    onCancelReject: function () {
      this.byId("rejectCommentDialog")?.close();
    },

    /* ========= BACKEND CALLS ========= */

    _approveRequest: function (sRequestId /*, sEmployeeId */) {
      const oModel = this.getView().getModel();
      const sApproverId = "MANAGER001"; // TODO: Get from session

      const oPayload = {
        requestId: sRequestId,
        approverId: sApproverId,
        comments: ""
      };

      if (oModel?.callFunction) {
        oModel.callFunction("/approveLeaveRequest", {
          method: "POST",
          urlParameters: oPayload,
          success: () => {
            MessageToast.show("Leave request approved");
            this.onRefresh();
          },
          error: (oError) => {
            MessageBox.error("Failed to approve leave request.\n" + (oError?.responseText || ""));
          }
        });
      } else {
        MessageBox.information("Implement OData action call");
      }
    },

    _rejectRequest: function (sRequestId, /* sEmployeeId, */ sComments) {
      const oModel = this.getView().getModel();
      const sApproverId = "MANAGER001"; // TODO: Get from session

      const oPayload = {
        requestId: sRequestId,
        approverId: sApproverId,
        comments: sComments
      };

      if (oModel?.callFunction) {
        oModel.callFunction("/rejectLeaveRequest", {
          method: "POST",
          urlParameters: oPayload,
          success: () => {
            MessageToast.show("Leave request rejected");
            this.onRefresh();
          },
          error: (oError) => {
            MessageBox.error("Failed to reject leave request.\n" + (oError?.responseText || ""));
          }
        });
      } else {
        MessageBox.information("Implement OData action call");
      }
    },

    /* ========= BULK OPERATIONS ========= */

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

    /* ========= LOGOUT ========= */

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
