using {my.leave_management as lm} from '../db/schemaDB';


service MyServices {
  entity Employees     as projection on lm.Employee;
  entity LeaveTypes    as projection on lm.LeaveType;
  entity LeaveRequests as projection on lm.LeaveRequest;
  entity LeaveBalances as projection on lm.LeaveBalance;
  entity Approvals     as projection on lm.Approval;

  action submitLeaveRequest(employeeId: String,
                            leaveTypeCode: String,
                            startDate: Date,
                            endDate: Date,
                            reason: String)        returns LeaveRequests;

  action approveLeaveRequest(requestId: String,
                             approverId: String,
                             comments: String)     returns LeaveRequests;

  action rejectLeaveRequest(requestId: String,
                            approverId: String,
                            comments: String)      returns LeaveRequests;

  action login(email: String, password: String) returns {
    success: Boolean;
    message: String;
    employee: {
      employeeID: String;
      firstName: String;
      lastName: String;
      email: String;
      department: String;
      designation: String;
    };
  };

 action register(
    employeeId : String(10),
    firstName  : String(50),
    lastName   : String(50),
    email      : String(100),
    password   : String(100),
    managerId  :String(10)
  ) returns {
    success    : Boolean;
    message    : String;
    employeeId : String(10);
  };



  // Get employee data by email

 action getEmployeeData(email: String) returns {
    success  : Boolean;
    message  : String;
    employee : {
      id         : String;
      employeeID : String;
      firstName  : String;
      lastName   : String;
      email      : String;
      department : String;
      managerID  : String;
    };
  };


  // Get employee leave balance
  action getEmployeeLeaveBalance(employeeID: String) returns {
    success: Boolean;
    message: String;
    balances: array of {
      id: String;
      leaveType: String;
      accruedDays: Decimal;
      usedDays: Decimal;
      balance: Decimal;
    };
    count: Integer;
  };

  // Get employee leave requests
  action getEmployeeLeaveRequests(employeeID: String) returns {
    success: Boolean;
    message: String;
    requests: array of {
      id: String;
      leaveType: String;
      startDate: Date;
      endDate: Date;
      daysRequested: Integer;
      reason: String;
      status: String;
      submittedAt: DateTime;
      approvedBy: String;
      approvedAt: DateTime;
    };
    count: Integer;
  };
}