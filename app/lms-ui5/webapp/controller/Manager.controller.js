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
        rejectData: {
          employeeName: "",
          leaveType: "",
          comments: "",
          commentLength: 0,
          requestId: "",
          employeeId: ""
        }
      });
      this.getView().setModel(oViewModel, "view");

      // Optional: default status
      this.byId("selStatus")?.setSelectedKey("Pending");

      // Load Employees and LeaveTypes for formatter lookups
      this._loadEmployeesAndLeaveTypes();
    },

    // Load Employees and LeaveTypes data for formatters
    _loadEmployeesAndLeaveTypes: function () {
       // OData model
      
const oModel = this.getView().getModel(); // OData v2 model assumed
  if (oModel && oModel.setSizeLimit) {
    oModel.setSizeLimit(10000); // raise according to expected volume
  }

      if (oModel) {
        // Load Employees
        oModel.read("/Employees", {
          success: (data) => {
            console.log("Employees loaded:", data);
            const oViewModel = this.getView().getModel("view");
            oViewModel.setProperty("/employees", data.value || []);
          },
          error: (err) => {
            console.error("Error loading employees:", err);
          }
        });
        

        // Load LeaveTypes
        oModel.read("/LeaveTypes", {
          success: (data) => {
            console.log("LeaveTypes loaded:", data);
            const oViewModel = this.getView().getModel("view");
            oViewModel.setProperty("/leaveTypes", data.value || []);
          },
          error: (err) => {
            console.error("Error loading leave types:", err);
          }
        });
      }
    },

    /* ===== Formatters ===== */

    formatEmployeeFullName: function (employeeId) {
      if (!employeeId) return "";
      try {
        const oViewModel = this.getView().getModel("view");
        const aEmployees = oViewModel?.getProperty("/employees") || [];
        const emp = aEmployees.find(e => e.employeeId === employeeId);
        if (emp) {
          const fullName = (emp.firstName || "") + " " + (emp.lastName || "");
          return fullName.trim();
        }
        return employeeId;
      } catch (e) {
        return employeeId;
      }
    },

    formatLeaveTypeCode: function (code) {
      if (!code) return "";
      try {
        const oViewModel = this.getView().getModel("view");
        const aLeaveTypes = oViewModel?.getProperty("/leaveTypes") || [];
        const type = aLeaveTypes.find(t => t.code === code);
        if (type) {
          return type.code;
        }
        return code;
      } catch (e) {
        return code;
      }
    },

    formatLeaveTypeDesc: function (code) {
      if (!code) return "";
      try {
        const oViewModel = this.getView().getModel("view");
        const aLeaveTypes = oViewModel?.getProperty("/leaveTypes") || [];
        const type = aLeaveTypes.find(t => t.code === code);
        if (type) {
          return type.description || type.code;
        }
        return code;
      } catch (e) {
        return code;
      }
    },

    formatLeaveTypeFullDesc: function (code) {
      if (!code) return "";
      try {
        const oViewModel = this.getView().getModel("view");
        const aLeaveTypes = oViewModel?.getProperty("/leaveTypes") || [];
        const type = aLeaveTypes.find(t => t.code === code);
        if (type) {
          return type.code + " - " + (type.description || "");
        }
        return code;
      } catch (e) {
        return code;
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

    formatStatusState: function (s) {
      switch ((s || "").toLowerCase()) {
        case "pending":
          return "Warning";
        case "approved":
          return "Success";
        case "rejected":
          return "Error";
        case "cancelled":
          return "None";
        default:
          return "None";
      }
    },

    /* ===== Table & Count ===== */
    onUpdateFinished: function (oEvent) {
      const oTable = this.byId("tblRequests");
      const oBinding = oTable?.getBinding("items");
      let iTotal = oEvent.getParameter("total");

      // Fallback: V4 ListBinding supports getLength()
      if ((iTotal === undefined || iTotal === null) && oBinding?.getLength) {
        iTotal = oBinding.getLength();
      }
      this.getView().getModel("view").setProperty("/counts/leaveRequests", iTotal ? `(${iTotal})` : "");

      // Dev aid: verify nav data presence in console (first row)
      try {
        const aItems = oTable.getItems();
        console.log(aItems,"check")
        if (aItems.length) {
          const obj = aItems[0].getBindingContext().getObject();
          console.log("First row object:", obj);
          console.log("employee_employeeId:", obj.employee_employeeId);
          console.log("leaveType_code:", obj.leaveType_code);
        }
      } catch (e) {
        console.log("onUpdateFinished error:", e);
      }
    },

    onRowPress: function (oEvent) {
      const ctx = oEvent.getSource().getBindingContext();
      const oPopover = this.byId("popDetails");
      if (oPopover && ctx) {
        oPopover.setBindingContext(ctx);
        oPopover.openBy(oEvent.getSource());
      }
    },

    /* ===== Filters & Search ===== */
    onStatusChange: function () {
      this._applyFilters();
    },

    onDateRangeChange: function () {
      this._applyFilters();
    },

    onLiveSearch: function () {
      this._applyFilters();
    },

    onSearch: function () {
      this._applyFilters();
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
    },

    onRefresh: function () {
      const oBinding = this.byId("tblRequests")?.getBinding("items");
      oBinding?.refresh();
      MessageToast.show("Data refreshed");
    },

    /* ===== Row Actions ===== */
    onApproveOne: function (oEvent) {
      const ctx = oEvent.getSource().getBindingContext();
      const oData = ctx?.getObject();
      if (!oData) return;

      const sEmployeeId = oData.employee_employeeId || "Unknown";
      const sRequestId = oData.ID;

      MessageBox.confirm("Approve leave request for " + sEmployeeId + "?", {
        onClose: (sAction) => {
          if (sAction === MessageBox.Action.OK) {
            this._approveRequest(sRequestId, sEmployeeId);
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

      const sEmployeeId = oData.employee_employeeId || "Unknown";
      const sRequestId = oData.ID;

      this._approveRequest(sRequestId, sEmployeeId);
      oPopover.close();
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

      const aRequestIds = aSelectedItems.map(item => item.getBindingContext().getProperty("ID"));
      console.log("Approving requests:", aRequestIds);
      MessageToast.show("Approving " + aRequestIds.length + " request(s)...");

      // TODO: Call backend to approve multiple requests
    },

    onRejectSelected: function () {
      const oTable = this.byId("tblRequests");
      const aSelectedItems = oTable?.getSelectedItems() || [];

      if (aSelectedItems.length === 0) {
        MessageToast.show("Please select at least one request");
        return;
      }

      const aRequestIds = aSelectedItems.map(item => item.getBindingContext().getProperty("ID"));
      console.log("Rejecting requests:", aRequestIds);
      MessageToast.show("Rejecting " + aRequestIds.length + " request(s)...");

      // TODO: Call backend to reject multiple requests
    },

    /* ===== Reject Dialog ===== */
    _openRejectDialog: function (oData) {
      const oViewModel = this.getView().getModel("view");
      
      // Populate reject dialog data
      oViewModel.setProperty("/rejectData/employeeName", this.formatEmployeeFullName(oData.employee_employeeId));
      oViewModel.setProperty("/rejectData/leaveType", this.formatLeaveTypeFullDesc(oData.leaveType_code));
      oViewModel.setProperty("/rejectData/comments", "");
      oViewModel.setProperty("/rejectData/commentLength", 0);
      oViewModel.setProperty("/rejectData/requestId", oData.ID);
      oViewModel.setProperty("/rejectData/employeeId", oData.employee_employeeId);

      // Open dialog
      const oDialog = this.byId("rejectCommentDialog");
      if (oDialog) {
        oDialog.open();
      }
    },

    onCommentChange: function (oEvent) {
      const sValue = oEvent.getParameter("value") || "";
      const oViewModel = this.getView().getModel("view");
      oViewModel.setProperty("/rejectData/commentLength", sValue.length);
    },

    onConfirmReject: function () {
      const oViewModel = this.getView().getModel("view");
      const oRejectData = oViewModel.getProperty("/rejectData");

      if (!oRejectData.comments.trim()) {
        MessageToast.show("Please enter rejection comments");
        return;
      }

      const sRequestId = oRejectData.requestId;
      const sEmployeeId = oRejectData.employeeId;
      const sComments = oRejectData.comments;

      this._rejectRequest(sRequestId, sEmployeeId, sComments);

      // Close dialog
      const oDialog = this.byId("rejectCommentDialog");
      if (oDialog) {
        oDialog.close();
      }
    },

    onCancelReject: function () {
      const oDialog = this.byId("rejectCommentDialog");
      if (oDialog) {
        oDialog.close();
      }
    },

    /* ===== Backend Calls ===== */
    _approveRequest: function (sRequestId, sEmployeeId) {
      const oModel = this.getView().getModel();
      const sApproverId = "MANAGER001"; // TODO: Get logged-in user ID

      const oPayload = {
        requestId: sRequestId,
        approverId: sApproverId,
        comments: ""
      };

      oModel.callFunction("/approveLeaveRequest", {
        method: "POST",
        urlParameters: oPayload,
        success: (oData) => {
          console.log("✅ Approval successful:", oData);
          MessageToast.show("Leave request approved for " + sEmployeeId);
          this.onRefresh();
        },
        error: (oError) => {
          console.error("❌ Approval failed:", oError);
          MessageBox.error("Failed to approve leave request. " + (oError.responseText || ""));
        }
      });
    },

    _rejectRequest: function (sRequestId, sEmployeeId, sComments) {
      const oModel = this.getView().getModel();
      const sApproverId = "MANAGER001"; // TODO: Get logged-in user ID

      const oPayload = {
        requestId: sRequestId,
        approverId: sApproverId,
        comments: sComments
      };

      oModel.callFunction("/rejectLeaveRequest", {
        method: "POST",
        urlParameters: oPayload,
        success: (oData) => {
          console.log("✅ Rejection successful:", oData);
          MessageToast.show("Leave request rejected for " + sEmployeeId);
          this.onRefresh();
        },
        error: (oError) => {
          console.error("❌ Rejection failed:", oError);
          MessageBox.error("Failed to reject leave request. " + (oError.responseText || ""));
        }
      });
    },

    /* ===== Internal: Apply filters ===== */
    _applyFilters: function () {
      const oBinding = this.byId("tblRequests")?.getBinding("items");
      if (!oBinding) return;

      const aFilters = [];

      // Status
      const sStatus = this.byId("selStatus")?.getSelectedKey();
      if (sStatus && sStatus !== "All") {
        aFilters.push(new Filter("status", FilterOperator.EQ, sStatus));
      }

      // Date Range (submittedAt)
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

      // Search (updated filter paths to match schema)
      const q = this.byId("reqSearch")?.getValue();
      if (q) {
        const orFilters = [
          new Filter("employee_employeeId", FilterOperator.Contains, q),
          new Filter("leaveType_code", FilterOperator.Contains, q),
          new Filter("reason", FilterOperator.Contains, q)
        ];
        aFilters.push(new Filter({ filters: orFilters, and: false }));
      }

      oBinding.filter(aFilters);
    },

    onLogout: function () {
      MessageBox.confirm("Are you sure you want to logout?", {
        onClose: (sAction) => {
          if (sAction === MessageBox.Action.OK) {
            // TODO: Clear session and redirect to login
            MessageToast.show("Logging out...");
            // window.location.href = "/login";
          }
        }
      });
    }
  });
});