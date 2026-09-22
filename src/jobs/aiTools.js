import prisma from "../config/prismaClient.js";


// 1. Define the tools for the AI (The "Menu" of available actions)
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
  // You can easily add more here later:
  // e.g., "create_task", "fetch_attendance", "send_email"
];

// 2. Define the exact backend code that runs when the AI chooses a tool
export const agentToolsHandlers = {
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

      if (!employee) {
        return { error: `No employee found matching the name '${employeeName}'.` };
      }

      return { 
        employee: employee.customerName, 
        pendingTasksCount: employee.assignedTasks.length,
        tasks: employee.assignedTasks
      };
    } catch (error) {
      console.error("Tool Execution Error:", error);
      return { error: "Failed to fetch tasks from the database." };
    }
  }
};