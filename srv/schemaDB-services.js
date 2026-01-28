const cds = require("@sap/cds");
const bcrypt = require("bcryptjs");

module.exports = cds.service.impl(async function () {
  const { Employees, LeaveRequests, LeaveBalances, LeaveTypes, Approvals } = this.entities;

  // UTILITY FUNCTIONS 
  function toMidnight(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function isWeekend(d) {
    const day = d.getDay(); // 0=Sun, 6=Sat
    return day === 0 || day === 6;
  }

  function businessDaysInclusive(start, end) {
    const s = toMidnight(start);
    const e = toMidnight(end);
    if (e < s) return 0;

    let count = 0;
    const cur = new Date(s);
    while (cur <= e) {
      if (!isWeekend(cur)) count++;
      cur.setDate(cur.getDate() + 1);
    }
    return count;
  }

  async function getAvailableBalance(tx, employee_employeeId, leaveType_code) {
    const row = await tx.run(
      SELECT.one.from(LeaveBalances).where({ employee_employeeId, leaveType_code })
    );
    const accrued = Number(row?.accruedDays || 0);
    const used = Number(row?.usedDays || 0);
    return accrued - used;
  }

  async function hasOverlap(tx, employee_employeeId, startDate, endDate) {
    const overlaps = await tx.run(
      SELECT.from(LeaveRequests).where({
        employee_employeeId,
        startDate: { "<=": endDate },
        endDate: { ">=": startDate },
        status: { "not in": ["Rejected", "Cancelled"] }
      })
    );
    return overlaps.length > 0;
  }

    // Get employee full name from employeeId
  async function getEmployeeName(tx, employeeId) {
    if (!employeeId) return "";

    try {
      const employee = await tx.run(
        SELECT.one.from(Employees)
          .columns("firstName", "lastName", "email")
          .where({ employeeId })
      );

      if (!employee) return employeeId;

      const fullName = [employee.firstName, employee.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();

      return fullName || employee.email || employeeId;
    } catch (error) {
      console.error(`Error fetching employee name for ${employeeId}:`, error);
      return employeeId;
    }
  }

  // HOOKS ON LEAVE REQUESTS 

  
  //  BEFORE CREATE: Validate and set empname
  
  // Update the BEFORE CREATE hook
this.before("CREATE", LeaveRequests, async (req) => {
  const tx = cds.transaction(req);
  const { employee_employeeId, leaveType_code, startDate, endDate } = req.data;

  // Validation
  if (!employee_employeeId || !leaveType_code || !startDate || !endDate) {
    req.reject(400, "Missing required fields (employee, leave type, startDate, endDate).");
  }
  if (new Date(startDate) > new Date(endDate)) {
    req.reject(400, "Start date cannot be after end date.");
  }

  // ✅ Calculate business days
  const daysRequested = businessDaysInclusive(startDate, endDate);
  if (daysRequested < 1) {
    req.reject(400, "The selected range contains no business days (Mon–Fri).");
  }

  const leaveType = await tx.run(SELECT.one.from(LeaveTypes).where({ code: leaveType_code }));
  if (!leaveType) {
    req.reject(400, "Invalid leave type.");
  }
  if (leaveType.maxDays && Number(leaveType.maxDays) > 0 && daysRequested > Number(leaveType.maxDays)) {
    req.reject(400, `Requested days (${daysRequested}) exceed maxDays (${leaveType.maxDays}).`);
  }

  const available = await getAvailableBalance(tx, employee_employeeId, leaveType_code);
  if (available < daysRequested) {
    req.reject(400, `Insufficient leave balance. Available: ${available}, requested: ${daysRequested}.`);
  }

  if (await hasOverlap(tx, employee_employeeId, startDate, endDate)) {
    req.reject(400, "Overlapping leave request exists.");
  }

  // ✅ IMPORTANT: Set daysRequested with calculated value
  req.data.daysRequested = daysRequested;
  req.data.submittedAt = new Date();
  if (!req.data.status) req.data.status = "Pending";

  // SET EMPLOYEE NAME
  if (!req.data.empname) {
    req.data.empname = await getEmployeeName(tx, employee_employeeId);
  }
});

    // AFTER CREATE: Update leave balance if approved

  this.after("CREATE", LeaveRequests, async (data) => {
    if (!data) return;
    if (data.status === "Approved") {
      await UPDATE(LeaveBalances)
        .set({ usedDays: { "+=": data.daysRequested } })
        .where({
          employee_employeeId: data.employee_employeeId,
          leaveType_code: data.leaveType_code,
        });
    }
  });

  
    // AFTER READ: Ensure empname is populated for all requests
   
  this.after("READ", LeaveRequests, async (results, req) => {
    const tx = cds.transaction(req);
    const rows = Array.isArray(results) ? results : (results ? [results] : []);

    for (const row of rows) {
      if (row && row.employee_employeeId) {
        // If empname is missing or equals employee ID, fetch the name
        if (!row.empname || row.empname === row.employee_employeeId) {
          row.empname = await getEmployeeName(tx, row.employee_employeeId);
        }
      }
    }
  });

  
  //  COMPUTED FIELD: LeaveBalances - calculate balance
  
  this.after("READ", LeaveBalances, (rows) => {
    const arr = Array.isArray(rows) ? rows : (rows ? [rows] : []);
    for (const each of arr) {
      const accrued = Number(each.accruedDays || 0);
      const used = Number(each.usedDays || 0);
      each.balance = accrued - used;
    }
  });



  // ACTION: submitLeaveRequest
// ACTION: submitLeaveRequest
this.on("submitLeaveRequest", async (req) => {
  const tx = cds.transaction(req);
  const { employeeId, leaveTypeCode, startDate, endDate, reason } = req.data;

  // Fetch employee
  const employee = await tx.run(SELECT.one.from(Employees).where({ employeeId }));
  if (!employee) req.reject(400, "Invalid employee.");

  // Get employee name
  const empName = await getEmployeeName(tx, employeeId);

  // Validate leave type
  const leaveType = await tx.run(SELECT.one.from(LeaveTypes).where({ code: leaveTypeCode }));
  if (!leaveType) req.reject(400, "Invalid leave type.");

  // ✅ Calculate business days
  const daysRequested = businessDaysInclusive(new Date(startDate), new Date(endDate));

  // Prepare entry
  const entry = {
    employee_employeeId: employeeId,
    leaveType_code: leaveTypeCode,
    startDate,
    endDate,
    daysRequested: daysRequested,  // ✅ Set calculated days
    reason: (reason || "").trim(),
    status: "Pending",
    empname: empName,
  };

  // Insert with fallback
  let created;
  try {
    const res = await tx.run(INSERT.into(LeaveRequests).entries(entry).returning("*"));
    created = Array.isArray(res) ? res[0] : res;
  } catch (e) {
    const ins = await tx.run(INSERT.into(LeaveRequests).entries(entry));
    const createdId = ins?.ID || ins?.ID_cuid || ins?.ID_uuid;
    created = createdId
      ? await tx.run(SELECT.one.from(LeaveRequests).where({ ID: createdId }))
      : await tx.run(
        SELECT.one.from(LeaveRequests)
          .where({
            employee_employeeId: employeeId,
            leaveType_code: leaveTypeCode,
            startDate,
            endDate
          })
          .orderBy({ submittedAt: "desc" })
      );
  }

  if (created) {
    created.empName = empName;
  }

  return created;
});

  // Approve a pending leave request
  this.on("approveLeaveRequest", async (req) => {
    const tx = cds.transaction(req);
    const { requestId, approverId, comments } = req.data;

    const request = await tx.run(SELECT.one.from(LeaveRequests).where({ ID: requestId }));
    if (!request || request.status !== "Pending") {
      req.reject(400, "Invalid or non-pending request.");
    }

    await tx.run(
      UPDATE(LeaveRequests)
        .set({ status: "Approved", approvedAt: new Date(), approvedBy: approverId })
        .where({ ID: requestId })
    );

    await tx.run(
      INSERT.into(Approvals).entries({
        leaveRequest_ID: requestId,
        approverId,
        status: "Approved",
        comments,
        approvedAt: new Date()
      })
    );

    await tx.run(
      UPDATE(LeaveBalances)
        .set({ usedDays: { "+=": request.daysRequested } })
        .where({ employee_employeeId: request.employee_employeeId, leaveType_code: request.leaveType_code })
    );

    return await tx.run(SELECT.one.from(LeaveRequests).where({ ID: requestId }));
  });

  //  ACTION: rejectLeaveRequest
 // Update the rejectLeaveRequest action
this.on("rejectLeaveRequest", async (req) => {
  const tx = cds.transaction(req);
  const { requestId, approverId, comments } = req.data;

  const request = await tx.run(SELECT.one.from(LeaveRequests).where({ ID: requestId }));
  if (!request || request.status !== "Pending") {
    req.reject(400, "Invalid or non-pending request.");
  }

  // ✅ UPDATE: Save manager comments in LeaveRequest
  await tx.run(
    UPDATE(LeaveRequests)
      .set({ 
        status: "Rejected",
        approvedAt: new Date(),
        approvedBy: approverId,
        managerComments: comments  // ✅ Store manager's rejection message
      })
      .where({ ID: requestId })
  );

  await tx.run(
    INSERT.into(Approvals).entries({
      leaveRequest_ID: requestId,
      approverId,
      status: "Rejected",
      comments,
      approvedAt: new Date()
    })
  );

  return await tx.run(SELECT.one.from(LeaveRequests).where({ ID: requestId }));
});

// Update the approveLeaveRequest action to also store comments
this.on("approveLeaveRequest", async (req) => {
  const tx = cds.transaction(req);
  const { requestId, approverId, comments } = req.data;

  const request = await tx.run(SELECT.one.from(LeaveRequests).where({ ID: requestId }));
  if (!request || request.status !== "Pending") {
    req.reject(400, "Invalid or non-pending request.");
  }

  // ✅ UPDATE: Save manager comments
  await tx.run(
    UPDATE(LeaveRequests)
      .set({ 
        status: "Approved", 
        approvedAt: new Date(), 
        approvedBy: approverId,
        managerComments: comments  // ✅ Store manager's approval message
      })
      .where({ ID: requestId })
  );

  await tx.run(
    INSERT.into(Approvals).entries({
      leaveRequest_ID: requestId,
      approverId,
      status: "Approved",
      comments,
      approvedAt: new Date()
    })
  );

  await tx.run(
    UPDATE(LeaveBalances)
      .set({ usedDays: { "+=": request.daysRequested } })
      .where({ employee_employeeId: request.employee_employeeId, leaveType_code: request.leaveType_code })
  );

  return await tx.run(SELECT.one.from(LeaveRequests).where({ ID: requestId }));
});

    // ACTION: cancelLeaveRequest
  this.on("cancelLeaveRequest", async (req) => {
    const tx = cds.transaction(req);
    const { requestId, cancellerId, comments } = req.data;

    const request = await tx.run(SELECT.one.from(LeaveRequests).where({ ID: requestId }));
    if (!request) req.reject(404, "Request not found.");
    if (!["Pending", "Approved"].includes(request.status)) {
      req.reject(400, "Only pending or approved requests can be cancelled.");
    }

    await tx.run(UPDATE(LeaveRequests).set({ status: "Cancelled" }).where({ ID: requestId }));

    await tx.run(
      INSERT.into(Approvals).entries({
        leaveRequest_ID: requestId,
        approverId: cancellerId || null,
        status: "Cancelled",
        comments: comments || null,
        approvedAt: new Date()
      })
    );

    if (request.status === "Approved") {
      await tx.run(
        UPDATE(LeaveBalances)
          .set({ usedDays: { "-=": request.daysRequested } })
          .where({ employee_employeeId: request.employee_employeeId, leaveType_code: request.leaveType_code })
      );
    }

    return await tx.run(SELECT.one.from(LeaveRequests).where({ ID: requestId }));
  });

  /**
   * ACTION: login
   * Authenticate user and return employee data
   */
  this.on("login", async (req) => {
    const tx = cds.transaction(req);
    const { email, password } = req.data;

    if (!email || !password) {
      return { success: false, message: "Email and password are required", employee: null };
    }

    try {
      const emp = await tx.run(SELECT.one.from(Employees).where({ email }));
      if (!emp) return { success: false, message: "Invalid email or password", employee: null };

      const isPasswordValid = await bcrypt.compare(password, emp.password);
      if (!isPasswordValid) {
        return { success: false, message: "Invalid email or password", employee: null };
      }

      const designation = emp.designation || "Employee";
      return {
        success: true,
        message: "Login successful",
        employee: {
          employeeID: String(emp.employeeId),
          firstName: emp.firstName || "",
          lastName: emp.lastName || "",
          email: emp.email || "",
          department: emp.department || "",
          designation
        }
      };
    } catch (error) {
      console.error("Login error:", error);
      return { success: false, message: "An error occurred during login. Please try again.", employee: null };
    }
  });

 
 
    // Register a new employee - HANA Compatible with Optional Manager
this.on('register', async (req) => {
  const { firstName, lastName, email, password, managerId } = req.data;

  console.log('[register] Request received:', { firstName, lastName, email });

  // Basic Validation 
  if (!firstName || !lastName || !email || !password) {
    console.log('[register] Missing required fields');
    return req.reject(400, 'Missing required fields');
  }

  if (password.length < 6) {
    console.log('[register] Password too short');
    return req.reject(400, 'Password must be at least 6 characters');
  }

  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(email)) {
    console.log('[register] Invalid email format');
    return req.reject(400, 'Invalid email address');
  }

  const tx = cds.transaction(req);

  try {
    // Check if email already exists 
    const existingEmp = await tx.run(
      SELECT.one.from(Employees).where({ email })
    );

    if (existingEmp) {
      console.log('[register] Email already registered:', email);
      return req.reject(409, 'User with this email already exists');
    }

    // Auto-generate Employee ID 
    console.log('[register] Generating next employee ID...');
    const lastEmployee = await tx.run(
      SELECT.one.from(Employees).orderBy({ employeeId: 'desc' })
    );

    let employeeId = 'E1001';
    if (lastEmployee && lastEmployee.employeeId) {
      const currentId = lastEmployee.employeeId; 
      const numericPart = parseInt(currentId.replace(/[^0-9]/g, ''), 10);
      if (!isNaN(numericPart)) {
        // Keep same padding length as currentId minus the leading 'E'
        employeeId = 'E' + String(numericPart + 1).padStart(currentId.length - 1, '0');
      }
    }
    console.log('[register] Generated employee ID:', employeeId);

    // Hash password 
    console.log('[register] Hashing password...');
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create Employee 
    console.log('[register] Creating employee...');
    await tx.run(
      INSERT.into(Employees).entries({
        employeeId,
        firstName,
        lastName,
        email,
        department: 'General',
        password: hashedPassword,
        managerId: managerId || null
      })
    );

    console.log('[register] Employee created');

    const employee = await tx.run(
      SELECT.one.from(Employees).where({ email })
    );

    console.log(employee, "empcheck");

    if (!employee) {
      console.log('[register] Failed to retrieve created employee');
      return req.reject(500, 'Failed to create employee');
    }

    // Initialize LeaveBalances for all LeaveTypes 
    try {
      const leaveTypes = await tx.run(SELECT.from(LeaveTypes));
      if (leaveTypes && leaveTypes.length > 0) {
        console.log('[register] Initializing leave balances for', leaveTypes.length, 'types');

        const balanceEntries = leaveTypes.map(lt => ({
          employee_ID: employee.ID,
          leaveType_ID: lt.ID,
          accruedDays: 0,
          usedDays: 0,
          balance: 0 
        }));

        await tx.run(INSERT.into(LeaveBalances).entries(balanceEntries));
        console.log('[register] LeaveBalances initialized');
      }
    } catch (e) {
      console.warn('[register] Leave balance initialization failed:', e.message);
    }

    await tx.commit();
    console.log('[register] Registration complete for:', email);

    return {
      success: true,
      message: 'Registered successfully. Please log in.',
      employeeId: employeeId,
      employee: {
        employeeID: String(employee.employeeId),
        firstName: employee.firstName,
        lastName: employee.lastName,
        email: employee.email
      }
    };

  } catch (e) {
    console.error('[register] Error:', e);
    await tx.rollback();
    return req.reject(500, e.message || 'Registration failed');
  }
});

  
    // ACTION: getEmployeeData
     this.on("getEmployeeData", async (req) => {
    const tx = cds.transaction(req);
    const { email } = req.data;
    if (!email) return { success: false, message: "Email is required" };

    try {
      const employee = await tx.run(SELECT.one.from(Employees).where({ email }));
      if (!employee) return { success: false, message: "Employee not found" };

      const balances = await tx.run(
        SELECT.from(LeaveBalances)
          .columns("ID", "accruedDays", "usedDays", "leaveType_code", "employee_employeeId")
          .where({ employee_employeeId: employee.employeeId })
      );

      const leaveBalances = (balances || []).map(b => ({
        id: String(b.ID),
        accruedDays: Number(b.accruedDays || 0),
        usedDays: Number(b.usedDays || 0),
        balance: Number(b.accruedDays || 0) - Number(b.usedDays || 0),
        leaveTypeCode: b.leaveType_code || ""
      }));

      return {
        success: true,
        message: "Employee data retrieved successfully",
        employee: {
          id: String(employee.employeeId),
          employeeID: String(employee.employeeId),
          firstName: employee.firstName,
          lastName: employee.lastName,
          email: employee.email,
          department: employee.department,
          managerID: employee.managerId || ""
        },
        leaveBalances
      };
    } catch (error) {
      console.error("getEmployeeData error:", error);
      return { success: false, message: "An error occurred retrieving employee data" };
    }
  });

  
   
    // Get leave balance for an employee
   
  this.on("getEmployeeLeaveBalance", async (req) => {
    const tx = cds.transaction(req);
    const { employeeID } = req.data;

    if (!employeeID) {
      return {
        success: false,
        message: "Employee ID is required",
        balances: [],
        count: 0
      };
    }

    try {
      const balances = await tx.run(
        SELECT.from(LeaveBalances)
          .where({ employee_employeeId: employeeID })
      );

      // Get leave type descriptions
      const leaveTypes = await tx.run(SELECT.from(LeaveTypes));
      const leaveTypeMap = {};
      (leaveTypes || []).forEach(lt => {
        leaveTypeMap[lt.code] = lt.description || lt.code;
      });

      const formattedBalances = (balances || []).map(b => ({
        id: String(b.ID),
        leaveType: leaveTypeMap[b.leaveType_code] || b.leaveType_code,
        accruedDays: Number(b.accruedDays || 0),
        usedDays: Number(b.usedDays || 0),
        balance: Number(b.accruedDays || 0) - Number(b.usedDays || 0)
      }));

      return {
        success: true,
        message: `Retrieved ${formattedBalances.length} balance(s)`,
        balances: formattedBalances,
        count: formattedBalances.length
      };
    } catch (error) {
      console.error("getEmployeeLeaveBalance error:", error);
      return {
        success: false,
        message: "An error occurred retrieving leave balances",
        balances: [],
        count: 0
      };
    }
  });

  
   // Get all leave requests for a specific employee
 // In srv/leave-service.js - update the leaveRequests action
this.on("leaveRequests", async (req) => {
  const tx = cds.transaction(req);
  const { employeeID } = req.data;

  if (!employeeID) {
    return {
      success: false,
      message: "Employee ID is required",
      requests: [],
      count: 0
    };
  }

  try {
    const requests = await tx.run(
      SELECT.from(LeaveRequests)
        .columns(
          "ID",
          "empname",
          "employee_employeeId",
          "leaveType_code",
          "startDate",
          "endDate",
          "daysRequested",
          "reason",
          "status",
          "submittedAt",
          "approvedBy",
          "approvedAt",
          "managerComments"  // ✅ ADD THIS
        )
        .where({ employee_employeeId: employeeID })
        .orderBy({ submittedAt: "desc" })
    );

    const leaveTypes = await tx.run(SELECT.from(LeaveTypes).columns("code", "description"));
    const leaveTypeMap = {};
    (leaveTypes || []).forEach(lt => {
      leaveTypeMap[lt.code] = lt.description || lt.code;
    });

    const formattedRequests = [];
    for (const req of requests || []) {
      let empname = req.empname;

      if (!empname || empname === req.employee_employeeId) {
        empname = await getEmployeeName(tx, req.employee_employeeId);
      }

      formattedRequests.push({
        id: String(req.ID),
        empname: empname,
        employeeId: req.employee_employeeId || "",
        leaveType: leaveTypeMap[req.leaveType_code] || req.leaveType_code,
        leaveTypeCode: req.leaveType_code,
        startDate: req.startDate,
        endDate: req.endDate,
        daysRequested: Number(req.daysRequested || 0),
        reason: req.reason || "",
        status: req.status || "Pending",
        submittedAt: req.submittedAt,
        approvedBy: req.approvedBy || "",
        approvedAt: req.approvedAt || null,
        managerComments: req.managerComments || ""  // ✅ ADD THIS
      });
    }

    return {
      success: true,
      message: `Retrieved ${formattedRequests.length} leave request(s)`,
      requests: formattedRequests,
      count: formattedRequests.length
    };
  } catch (error) {
    console.error("leaveRequests error:", error);
    return {
      success: false,
      message: "An error occurred retrieving leave requests",
      requests: [],
      count: 0
    };
  }
});
});