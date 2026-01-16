
// srv/schemaDB-service.js
const cds = require('@sap/cds');
const bcrypt = require('bcryptjs');

module.exports = cds.service.impl(async function () {

  const { Employees, LeaveRequests, LeaveBalances, LeaveTypes, Approvals } = this.entities;

  // ---------- Utilities ----------
  function calculateDays(start, end) {
    return Math.ceil((new Date(end) - new Date(start)) / (1000 * 60 * 60 * 24)) + 1;
  }

  const fail = (message) => ({ success: false, message });

  async function findEmployeeByEmail(email) {
    if (!email) return null;
    return await SELECT.one.from(Employees).where({ email });
  }


  async function findLeaveByEmail(employeeId) {
    if (!employeeId) return null;
    return await SELECT.from(LeaveBalances)
      .where({ 'employee_employeeId': employeeId });
  }

  // ---------- LEAVE MANAGEMENT HOOKS ----------
  this.before('CREATE', LeaveRequests, async (req) => {
    const { employee_employeeId, leaveType_code, startDate, endDate } = req.data;

    if (new Date(startDate) >= new Date(endDate)) {
      throw new Error('End date must be after start date.');
    }

    // Get balance (compute explicitly to avoid relying on after READ)
    const balanceRow = await SELECT.one
      .from(LeaveBalances)
      .where({ employee_employeeId, leaveType_code });

    const daysRequested = calculateDays(startDate, endDate);
    const available = balanceRow
      ? Number(balanceRow.accruedDays || 0) - Number(balanceRow.usedDays || 0)
      : 0;

    if (available < daysRequested) {
      throw new Error('Insufficient leave balance.');
    }

    const overlaps = await SELECT
      .from(LeaveRequests)
      .where({
        employee_employeeId,
        startDate: { '<=': endDate },
        endDate: { '>=': startDate },
        status: { '!=': 'Rejected' },
      });

    if (overlaps.length > 0) {
      throw new Error('Overlapping leave request exists.');
    }

    req.data.daysRequested = daysRequested;
    req.data.submittedAt = new Date();
  });

  this.after('CREATE', LeaveRequests, async (data) => {
    if (data.status === 'Approved') {
      await UPDATE(LeaveBalances)
        .set({ usedDays: { '+=': data.daysRequested } })
        .where({
          employee_employeeId: data.employee_employeeId,
          leaveType_code: data.leaveType_code,
        });
    }
  });

  this.on('submitLeaveRequest', async (req) => {
    const { employeeId, leaveTypeCode, startDate, endDate, reason } = req.data;

    const employee = await SELECT.one.from(Employees).where({ employeeId });
    const leaveType = await SELECT.one.from(LeaveTypes).where({ code: leaveTypeCode });

    if (!employee || !leaveType) {
      throw new Error('Invalid employee or leave type.');
    }

    const request = await INSERT.into(LeaveRequests).entries({
      employee_employeeId: employeeId,
      leaveType_code: leaveTypeCode,
      startDate,
      endDate,
      reason,
      status: 'Pending',
    });

    return request;
  });

  this.on('approveLeaveRequest', async (req) => {
    const { requestId, approverId, comments } = req.data;

    const request = await SELECT.one.from(LeaveRequests).where({ ID: requestId });
    if (!request || request.status !== 'Pending') {
      throw new Error('Invalid or non-pending request.');
    }

    await UPDATE(LeaveRequests)
      .set({ status: 'Approved', approvedAt: new Date(), approvedBy: approverId })
      .where({ ID: requestId });

    await INSERT.into(Approvals).entries({
      leaveRequest_ID: requestId,
      approverId,
      status: 'Approved',
      comments,
      approvedAt: new Date(),
    });

    await UPDATE(LeaveBalances)
      .set({ usedDays: { '+=': request.daysRequested } })
      .where({
        employee_employeeId: request.employee_employeeId,
        leaveType_code: request.leaveType_code,
      });

    return await SELECT.one.from(LeaveRequests).where({ ID: requestId });
  });

  this.on('rejectLeaveRequest', async (req) => {
    const { requestId, approverId, comments } = req.data;

    const request = await SELECT.one.from(LeaveRequests).where({ ID: requestId });
    if (!request || request.status !== 'Pending') {
      throw new Error('Invalid or non-pending request.');
    }

    await UPDATE(LeaveRequests).set({ status: 'Rejected' }).where({ ID: requestId });

    await INSERT.into(Approvals).entries({
      leaveRequest_ID: requestId,
      approverId,
      status: 'Rejected',
      comments,
      approvedAt: new Date(),
    });

    return await SELECT.one.from(LeaveRequests).where({ ID: requestId });
  });

  this.after('READ', LeaveBalances, (each) => {
    each.balance = Number(each.accruedDays || 0) - Number(each.usedDays || 0);
  });

  // ==================== LOGIN ACTION (Leave Management) ====================
  this.on('login', async (req) => {
    const { email, password } = req.data;
    // 1) Validate input
    if (!email || !password) {
      return {
        success: false,
        message: 'Email and Employee ID are Found',
        employee: null
      };
    }

    try {
      // 2) Find employee by email via CAP entity (portable for HANA/SQLite)
      const emp = await SELECT.one.from(Employees).where({ email });
      // If not found, fail early
      if (!emp) {
        return {
          success: false,
          message: 'Invalid email or employee ID',
          employee: null
        };
      }

      const isPasswordValid = await bcrypt.compare(password, emp.password);
      // 4) Optional: update a timestamp (managed aspect often handles modifiedAt automatically)

      if (!isPasswordValid) {
        return {
          success: false,
          message: 'Invalid email or password',
          employee: null
        };
      }

      const designation = emp.designation || 'Employee'; 

      return {
        success: true,
        message: 'Login successful',
        employee: {
          employeeID: String(emp.employeeId),
          firstName: emp.firstName || '',
          lastName: emp.lastName || '',
          email: emp.email || '',
          department: emp.department || '',
          designation
        }
      };

    } catch (error) {
      console.error('Login error:', error);
      return {
        success: false,
        message: 'An error occurred during login. Please try again.',
        employee: null
      };
    }
  });


  // ==================== REGISTRATION ACTION ====================

  this.on('register', async (req) => {
    const { firstName, lastName, email, password } = req.data;
    // ---- Basic Validation (server-side) ----
    if (!firstName || !lastName || !email || !password) {
      console.log('[register] ❌ Missing required fields');
      return req.reject(400, 'Missing required fields');
    }

    if (password.length < 6) {
      console.log('[register] ❌ Password too short');
      return req.reject(400, 'Password must be at least 6 characters');
    }

    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailPattern.test(email)) {
      console.log('[register] ❌ Invalid email format');
      return req.reject(400, 'Invalid email address');
    }

    const tx = cds.transaction(req);

    try {
      // ---- Check if email already exists ----
      console.log('🔍 Checking for existing employee with email:', email);

      const existingEmp = await tx.run(
        SELECT.one.from(Employees).where({ email })
      );

      if (existingEmp) {
        console.log('[register] ⚠️ Email already registered:', email);
        return req.reject(409, 'User with this email already exists');
      }
      console.log('✅ Email is available');


      console.log('🔐 Hashing password...');
      const saltRounds = 10;
      const hashedPassword = await bcrypt.hash(password, saltRounds);
      console.log('✅ Password hashed successfully');

      // ---- Auto-generate Employee ID ----
      console.log('🔢 Generating next employee ID...');

      const lastEmployee = await tx.run(
        SELECT.one.from(Employees).orderBy({ employeeId: 'desc' })
      );

      let employeeId = 'E1001';
      if (lastEmployee && lastEmployee.employeeId) {
        const currentId = lastEmployee.employeeId;
        console.log('   - Last Employee ID found:', currentId);
        const numericPart = parseInt(currentId.replace(/[^0-9]/g, ''), 10);
        if (!isNaN(numericPart)) {
          employeeId = 'E' + String(numericPart + 1).padStart(currentId.length - 1, '0');
        }
      } else {
        console.log('   - No existing employees, starting with E1001');
      }
      console.log('✅ Generated employee ID:', employeeId);

      const insertResult = await tx.run(
        INSERT.into(Employees).entries({
          employeeId,
          firstName,
          lastName,
          email,
          department: 'General',
          password: hashedPassword,
        })
      );

      console.log('✅ INSERT completed');
      console.log('   - Insert Result:', insertResult);

      // Get the full employee record (to obtain technical ID for FKs)
      console.log('🔍 Retrieving created employee from database...');

      const employee = await tx.run(
        SELECT.one.from(Employees).where({ email })
      );

      if (!employee) {
        console.log('[register] ❌ Failed to retrieve created employee');
        console.log('   - This might indicate the data was not saved!');
        return req.reject(500, 'Failed to create employee');
      }

      console.log('========================================');
      console.log('✅ REGISTRATION SUCCESSFUL');
      console.log('========================================');
      console.log('   - Employee saved to:', cds.db.kind);
      console.log('   - Employee ID:', employeeId);
      console.log('   - Email:', email);
      console.log('========================================');

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
      console.error('========================================');
      console.error('❌ REGISTRATION ERROR');
      console.error('========================================');
      console.error('[register] Error:', e);
      console.error('   - Error Message:', e.message);
      console.error('   - Error Stack:', e.stack);
      console.error('   - Database Kind:', cds.db.kind);
      console.error('========================================');
      return req.reject(500, e.message || 'Registration failed');
    }
  });


  // ---------- GET EMPLOYEE DATA (by email) ----------
  this.on('getEmployeeData', async (req) => {
    const { email } = req.data;
    if (!email) return req.reject(400, 'Email is required');

    const tx = cds.transaction(req);

    // Find employee by email from service projection
    const employee = await tx.run(
      SELECT.one.from(Employees).where({ email })
    );

    if (!employee) return req.reject(404, 'Employee not found');

    // Retrieve leave balances for that employee (FK: employee_ID)
    // and also join type info for a richer payload
    const balances = await tx.run(
      SELECT.from(LeaveBalances)
        .columns(
          'ID',
          'accruedDays',
          'usedDays',
          'balance',
          'leaveType_ID',
          'employee_ID',
          // pull leave type code/description via expand or second query
          { ref: ['leaveType_ID'], as: 'leaveTypeId' }
        )
        .where({ employee_ID: employee.ID })
    );

    // If you prefer code/description, join against LeaveTypes
    // (expand is not supported in plain SELECT; do a second query)
    let leaveTypesById = {};
    if (balances?.length) {
      const typeIds = [...new Set(balances.map(b => b.leaveType_ID).filter(Boolean))];
      if (typeIds.length) {
        const types = await tx.run(
          SELECT.from(LeaveTypes)
            .columns('ID', 'code', 'description')
            .where({ ID: { in: typeIds } })
        );
        leaveTypesById = Object.fromEntries(types.map(t => [t.ID, t]));
      }
    }

    // Map to client format
    const leaveBalances = (balances || []).map(b => {
      const t = leaveTypesById[b.leaveType_ID] || {};
      return {
        id: String(b.ID),
        accruedDays: b.accruedDays,
        usedDays: b.usedDays,
        balance: b.balance,
        leaveTypeId: b.leaveType_ID ? String(b.leaveType_ID) : '',
        leaveTypeCode: t.code || '',
        leaveTypeDescription: t.description || ''
      };
    });

    // If you want to allow empty balances (new employee) return success anyway.
    // If you want to *require* balances, keep the check below.
    // if (!leaveBalances.length) return req.reject(404, 'No leave data found for employee');

    return {
      success: true,
      message: 'Employee data retrieved successfully',
      employee: {
        id: String(employee.ID),
        employeeID: String(employee.employeeId),
        firstName: employee.firstName,
        lastName: employee.lastName,
        email: employee.email,
        department: employee.department,
        managerID: employee.managerId || ''
      },
      leaveBalances
    };
  });

  // ---------- OPTIONAL: helper functions bound to service projections ----------
  // If you prefer to keep helper functions, ensure they use srv.entities and tx.run

  async function findEmployeeByEmail(tx, email) {
    return tx.run(SELECT.one.from(Employees).where({ email }));
  }

  async function findLeaveByEmployeeId(tx, employeeId) {
    // Resolve Employee.ID by employeeId, then query balances by employee_ID
    const emp = await tx.run(SELECT.one.from(Employees).where({ employeeId }));
    if (!emp) return [];
    return tx.run(SELECT.from(LeaveBalances).where({ employee_ID: emp.ID }));
  }
});
