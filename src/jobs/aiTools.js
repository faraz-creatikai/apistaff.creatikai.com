import prisma from "../config/prismaClient.js";

// ============================================================================
// 1. TOOL DEFINITIONS (The "Menu" for the AI)
// ============================================================================
export const agentToolsDefinitions = [
  {
    name: "get_employee_pending_tasks",
    description: "Fetches the current pending tasks and their details for a specific employee.",
    parameters: {
      type: "object",
      properties: {
        employeeName: { type: "string", description: "The first or full name of the employee" }
      },
      required: ["employeeName"]
    }
  },
  {
    name: "analyze_team_attendance",
    description: "Generates an attendance and work-hours report for the team or a specific employee over a given number of days.",
    parameters: {
      type: "object",
      properties: {
        daysBack: { type: "number", description: "Number of days to look back (e.g., 7 for a week, 30 for a month)." },
        employeeName: { type: "string", description: "Optional. Filter by a specific employee's name." }
      },
      required: ["daysBack"]
    }
  },
  {
    name: "get_overdue_tasks_report",
    description: "Fetches a risk report of all overdue tasks that are not yet completed, grouped by employee.",
    parameters: {
      type: "object",
      properties: {
        campaign: { type: "string", description: "Optional. Filter by a specific Campaign or Department name." }
      },
      required: []
    }
  },
  {
    name: "get_employee_performance_metrics",
    description: "Calculates deep performance metrics for an employee, including task completion rates and subtask step progression.",
    parameters: {
      type: "object",
      properties: {
        employeeName: { type: "string", description: "The first or full name of the employee." }
      },
      required: ["employeeName"]
    }
  }
];

// ============================================================================
// 2. TOOL HANDLERS (The Backend Logic)
// ============================================================================
export const agentToolsHandlers = {
  
  // Existing tool
  get_employee_pending_tasks: async ({ employeeName }) => {
    try {
      const employee = await prisma.customer.findFirst({
        where: { customerName: { contains: employeeName } },
        include: { 
          assignedTasks: { 
            where: { status: { not: "completed" } },
            select: { title: true, priority: true, dueDate: true, status: true }
          } 
        }
      });

      if (!employee) return { error: `No employee found matching '${employeeName}'.` };

      return { 
        employee: employee.customerName, 
        pendingTasksCount: employee.assignedTasks.length,
        tasks: employee.assignedTasks
      };
    } catch (error) {
      console.error("Tool Execution Error:", error);
      return { error: "Failed to fetch tasks." };
    }
  },

  // NEW: Attendance Analyzer
  analyze_team_attendance: async ({ daysBack, employeeName }) => {
    try {
      const targetDate = new Date();
      targetDate.setDate(targetDate.getDate() - daysBack);

      const whereClause = { createdAt: { gte: targetDate } };
      if (employeeName) {
        whereClause.customer = { customerName: { contains: employeeName } };
      }

      const logs = await prisma.customerAttendance.findMany({
        where: whereClause,
        include: { customer: { select: { customerName: true, Campaign: true } } }
      });

      if (logs.length === 0) return { message: `No attendance records found for the last ${daysBack} days.` };

      // Aggregate data
      let totalMinutes = 0;
      const statusCounts = { present: 0, absent: 0, half_day: 0, workfromhome: 0, leave: 0 };
      const employeeStats = {};

      logs.forEach(log => {
        statusCounts[log.status] = (statusCounts[log.status] || 0) + 1;
        totalMinutes += log.totalMinutes || 0;

        const name = log.customer.customerName;
        if (!employeeStats[name]) employeeStats[name] = { present: 0, absent: 0, totalMinutes: 0 };
        employeeStats[name].totalMinutes += log.totalMinutes || 0;
        if (log.status === "present" || log.status === "workfromhome") employeeStats[name].present++;
        if (log.status === "absent" || log.status === "leave") employeeStats[name].absent++;
      });

      return {
        timeframe: `Last ${daysBack} days`,
        totalRecords: logs.length,
        overallStatusCounts: statusCounts,
        totalHoursLogged: Math.round(totalMinutes / 60),
        breakdownByEmployee: employeeStats // AI will read this and format a nice summary table/list
      };
    } catch (error) {
      console.error("Tool Execution Error:", error);
      return { error: "Failed to analyze attendance data." };
    }
  },

  // NEW: Overdue Tasks Risk Report
  get_overdue_tasks_report: async ({ campaign }) => {
    try {
      const whereClause = {
        status: { not: "completed" },
        dueDate: { lt: new Date() } // Past due
      };

      if (campaign) {
        whereClause.assignedTo = { Campaign: { contains: campaign } };
      }

      const overdueTasks = await prisma.task.findMany({
        where: whereClause,
        include: {
          assignedTo: { select: { customerName: true, Campaign: true } },
          subTasks: { select: { isCompleted: true } }
        },
        orderBy: { dueDate: 'asc' } // Oldest first
      });

      if (overdueTasks.length === 0) return { message: "Great news! There are no overdue tasks." };

      const formattedTasks = overdueTasks.map(t => {
        const totalSteps = t.subTasks.length;
        const completedSteps = t.subTasks.filter(st => st.isCompleted).length;
        
        return {
          title: t.title,
          assignedTo: t.assignedTo.customerName,
          department: t.assignedTo.Campaign,
          priority: t.priority,
          daysOverdue: Math.floor((new Date() - new Date(t.dueDate)) / (1000 * 60 * 60 * 24)),
          progress: totalSteps > 0 ? `${completedSteps}/${totalSteps} steps done` : "No subtasks"
        };
      });

      return {
        totalOverdue: overdueTasks.length,
        criticalRisks: formattedTasks.filter(t => t.priority === 'urgent' || t.priority === 'high'),
        allOverdueTasks: formattedTasks
      };
    } catch (error) {
      console.error("Tool Execution Error:", error);
      return { error: "Failed to fetch overdue tasks." };
    }
  },

  // NEW: Deep Employee Performance Metrics
  get_employee_performance_metrics: async ({ employeeName }) => {
    try {
      const employee = await prisma.customer.findFirst({
        where: { customerName: { contains: employeeName } },
        include: {
          assignedTasks: {
            include: { subTasks: true }
          }
        }
      });

      if (!employee) return { error: `Could not find an employee named '${employeeName}'.` };

      const tasks = employee.assignedTasks;
      const totalTasks = tasks.length;
      if (totalTasks === 0) return { message: `${employee.customerName} has no assigned tasks.` };

      const completedTasks = tasks.filter(t => t.status === "completed").length;
      const pendingTasks = tasks.filter(t => t.status !== "completed").length;
      const overdueTasks = tasks.filter(t => t.dueDate && new Date(t.dueDate) < new Date() && t.status !== "completed").length;

      // Subtask granular metrics
      let totalSubTasks = 0;
      let completedSubTasks = 0;

      tasks.forEach(t => {
        totalSubTasks += t.subTasks.length;
        completedSubTasks += t.subTasks.filter(st => st.status === "completed" || st.isCompleted).length;
      });

      return {
        employeeName: employee.customerName,
        campaign: employee.Campaign,
        macroMetrics: {
          totalAssigned: totalTasks,
          completed: completedTasks,
          pending: pendingTasks,
          overdue: overdueTasks,
          completionRate: `${Math.round((completedTasks / totalTasks) * 100)}%`
        },
        microMetrics: {
          totalStepsAssigned: totalSubTasks,
          stepsCompleted: completedSubTasks,
          stepCompletionRate: totalSubTasks > 0 ? `${Math.round((completedSubTasks / totalSubTasks) * 100)}%` : "N/A"
        }
      };
    } catch (error) {
      console.error("Tool Execution Error:", error);
      return { error: "Failed to calculate performance metrics." };
    }
  }
};