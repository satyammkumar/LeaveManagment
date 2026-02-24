
sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast",
  "sap/m/MessageBox",
  "sap/ui/core/format/DateFormat"
], function (Controller, JSONModel, MessageToast, MessageBox, DateFormat) {
  "use strict";

  return Controller.extend("lmsui5.controller.ApplyLeave", {

    onInit: function () {
      // JSON model to hold dialog state
      var oApplyLeaveModel = new JSONModel({
        selectedLeaveType: "", 
        selectedDates: [],    
        reason: "",
        minDate: null,         
        maxDate: null         
      });
      this.getView().setModel(oApplyLeaveModel, "applyLeave");

      this._oDateFmt = DateFormat.getDateInstance({ pattern: "yyyy-MM-dd" });
    },

    // Collect dates sap.ui.unified.Calendar
    onCalendarSelect: function () {
      var oCal = this.byId("leaveCalendar");
      var aRanges = oCal.getSelectedDates() || [];
      var aDates = [];

      aRanges.forEach(function (oRange) {
        var dStart = oRange.getStartDate();
        var dEnd = oRange.getEndDate(); 
        if (dStart && dEnd) {
          var d = new Date(dStart);
          d.setHours(0, 0, 0, 0);
          var end = new Date(dEnd);
          end.setHours(0, 0, 0, 0);
          while (d <= end) {
            aDates.push(new Date(d.getFullYear(), d.getMonth(), d.getDate()));
            d.setDate(d.getDate() + 1);
          }
        } else if (dStart) {
          var dOnly = new Date(dStart.getFullYear(), dStart.getMonth(), dStart.getDate());
          aDates.push(dOnly);
        }
      });

      // Deduplicate 
      var mSeen = {};
      aDates = aDates.filter(function (d) {
        var k = d.toDateString();
        if (mSeen[k]) return false;
        mSeen[k] = true;
        return true;
      }).sort(function (a, b) { return a - b; });

      this.getView().getModel("applyLeave").setProperty("/selectedDates", aDates);
    },

    _toYMD: function (d) {
      var yyyy = d.getFullYear();
      var mm = String(d.getMonth() + 1).padStart(2, "0");
      var dd = String(d.getDate()).padStart(2, "0");
      return `${yyyy}-${mm}-${dd}`;
    },

    /**
     * Helper: fetch LeaveType ID (UUID) by business key 'code'
      
     */
    _fetchLeaveTypeByCode: async function (sCode) {
      const oModel = this.getView().getModel();
      const oList = oModel.bindList("/LeaveTypes", null, null, null, {
        $select: "ID,code",
        $filter: "code eq '" + String(sCode).replace(/'/g, "''") + "'"
      });
      const aCtx = await oList.requestContexts(0, 1);
      if (!aCtx.length) {
        throw new Error("Leave type not found for code: " + sCode);
      }
      const oObj = aCtx[0].getObject();
      return { id: oObj.ID, code: oObj.code };
    },

    onSubmitLeave: async function () {
      const oView = this.getView();
      const oApply = oView.getModel("applyLeave");
      const oModel = oView.getModel();        
      const oAuth  = this.getOwnerComponent().getModel("auth");

      // From UI
      const sLeaveCode = oApply.getProperty("/selectedLeaveType"); 
      const aDates     = oApply.getProperty("/selectedDates") || [];
      const sReason    = oApply.getProperty("/reason") || "";

      // From auth (must contain both cuid UUID and business key)
      const oUser = (oAuth && oAuth.getProperty("/user")) || {};
      const sEmpUUID = oUser.id;           
      const sEmpCode = oUser.employeeID;   

      // Validation
      if (!sLeaveCode) {
        MessageBox.warning("Please select a leave type.");
        return;
      }
      if (!aDates.length) {
        MessageBox.warning("Please select at least one date.");
        return;
      }
      if (!sEmpUUID || !sEmpCode) {
        MessageBox.error("Missing employee identity. Please log in again.");
        return;
      }

      // start/end
      const aSorted = aDates.slice().sort((a, b) => a - b);
      const sStart = this._toYMD(aSorted[0]);
      const sEnd   = this._toYMD(aSorted[aSorted.length - 1]);

      try {
        // Fetch LeaveType UUID by code
        const oLeaveType = await this._fetchLeaveTypeByCode(sLeaveCode);

        // Build payload 
        const oPayload = {
          employee_ID: sEmpUUID,
          employee_employeeId: sEmpCode,

          leaveType_ID: oLeaveType.id,
          leaveType_code: oLeaveType.code,

          startDate: sStart,   
          endDate:   sEnd,     
          reason:    sReason,
          status:    "Pending"
        };

        // OData V4 create on plural entity set
        const oListBinding = oModel.bindList("/LeaveRequests");
        const oContext = oListBinding.create(oPayload);

        await oContext.created(); 
        const oCreated = oContext.getObject();
        const sNewId = oCreated && (oCreated.ID || oCreated.ID_cuid || oCreated.ID_uuid);

        MessageToast.show("Leave submitted successfully.");
        // Go to Manager dashboard 
        this.getOwnerComponent().getRouter().navTo("ManagerNoId");
      } catch (e) {
        var sMsg = "Failed to submit leave request.";
        if (e && e.message) sMsg += "\n" + e.message;
        MessageBox.error(sMsg);
      }
    },

    onCancelApplyLeave: function () {
      this.byId("applyLeaveDialog").close();
    }
  });
});
