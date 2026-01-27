namespace my.leave_management;

using {
  cuid,
  managed
} from '@sap/cds/common';

entity Employee : cuid, managed {
  key employeeId    : String(10);
      firstName     : String(50);
      lastName      : String(50);
      email         : String(100);
      department    : String(50);
      managerId     : String(10);
      password      : String(1000);
      leaveRequests : Association to many LeaveRequest
                        on leaveRequests.employee = $self;
      leaveBalances : Association to many LeaveBalance
                        on leaveBalances.employee = $self;
}

entity LeaveType : cuid, managed {
  key code          : String(10) @unique;
      description   : String(100);
      isPaid        : Boolean;
      maxDays       : Integer;
      leaveRequests : Association to many LeaveRequest
                        on leaveRequests.leaveType = $self;
      leaveBalances : Association to many LeaveBalance
                        on leaveBalances.leaveType = $self;
}

entity LeaveRequest : cuid, managed {
  empname:String(200);
  employee      : Association to Employee;
  leaveType     : Association to LeaveType;
  startDate     : Date;
  endDate       : Date;
  daysRequested : Integer @readonly;
  reason        : String(500);
  status        : String(20) enum {
    Pending;
    Approved;
    Rejected;
    Cancelled
  } default 'Pending';
  submittedAt   : DateTime;
  approvedAt    : DateTime;
  approvedBy    : String(10);
  approvals     : Association to many Approval
                    on approvals.leaveRequest = $self;
}

entity LeaveBalance : cuid, managed {
  employee    : Association to Employee;
  leaveType   : Association to LeaveType;
  accruedDays : Decimal(5, 2);
  usedDays    : Decimal(5, 2);
  balance     : Decimal(5, 2) @readonly;
}

entity Approval : cuid, managed {
  leaveRequest : Association to LeaveRequest;
  approverId   : String(10);
  status       : String(20) enum {
    Pending;
    Approved;
    Rejected
  } default 'Pending';
  comments     : String(500);
  approvedAt   : DateTime;
}
