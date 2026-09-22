import express from "express";


import { validate } from "../middlewares/validate.js";


import { isAdministrator, protectEmployeeRoute, protectRoute } from "../middlewares/auth.js";
import { createAIAgentValidator, updateAIAgentValidator } from "../validators/aiagentValidator.js";
import { assignAIAgent, compareProductPrice, createAIAgent, deleteAIAgent, deleteSession, getAIAgentById, getAIAgents, getChatSessions, getDailyAIReports, getSessionMessages, handleAiChat, runWebhookAgent, toggleSessionPin, updateAIAgent } from "../controllers/controller.aiagent.js";

const aiAgentRoutes = express.Router();

// Protect all routes
aiAgentRoutes.use(protectRoute);

// GET ALL AGENTS
aiAgentRoutes.get("/", getAIAgents);

// 24/7 ai agent route

aiAgentRoutes.get('/ai-reports', protectRoute, getDailyAIReports);

// GET SINGLE AGENT
aiAgentRoutes.get("/:id", isAdministrator, getAIAgentById);

// CREATE AGENT
aiAgentRoutes.post(
    "/",
    isAdministrator,
    validate(createAIAgentValidator),
    createAIAgent
);

// UPDATE AGENT
aiAgentRoutes.put(
    "/:id",
    isAdministrator,
    validate(updateAIAgentValidator),
    updateAIAgent
);

//ASSIGN AGENT
aiAgentRoutes.post("/assign", assignAIAgent);

// DELETE AGENT
aiAgentRoutes.delete("/:id", isAdministrator, deleteAIAgent);

aiAgentRoutes.post("/run-webhook-agent", runWebhookAgent);
aiAgentRoutes.post("/compare-product-price",compareProductPrice);


// ==========================================
// ADMIN AGENT ROUTES
// ==========================================
aiAgentRoutes.post("/admin/message", protectRoute, handleAiChat);
aiAgentRoutes.get("/admin/sessions", protectRoute, getChatSessions);
aiAgentRoutes.get("/admin/sessions/:sessionId/messages", protectRoute, getSessionMessages);
aiAgentRoutes.patch("/admin/sessions/:sessionId/pin", protectRoute, toggleSessionPin);
aiAgentRoutes.delete("/admin/sessions/:sessionId", protectRoute, deleteSession);

// ==========================================
// EMPLOYEE AGENT ROUTES
// ==========================================
// Employees hit the same exact controllers, but the middleware ensures 
// they only see their own sessions and data.
aiAgentRoutes.post("/employee/agent/message", protectEmployeeRoute, handleAiChat);
aiAgentRoutes.get("/employee/agent/sessions", protectEmployeeRoute, getChatSessions);
aiAgentRoutes.get("/employee/agent/sessions/:sessionId/messages", protectEmployeeRoute, getSessionMessages);
aiAgentRoutes.patch("/employee/agent/sessions/:sessionId/pin", protectEmployeeRoute, toggleSessionPin);
aiAgentRoutes.delete("/employee/agent/sessions/:sessionId", protectEmployeeRoute, deleteSession);




export default aiAgentRoutes;