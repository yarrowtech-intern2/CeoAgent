import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import Bill from "../models/Bill.model.js";
import Restaurant from "../models/Restaurant.model.js";
import { listCustomers, listOrders, listProducts } from "./ceoAgentData.Controller.js";

/* =========================================================
   MCP ENDPOINT FOR THE CEO AGENT
   POST /api/ceo-agent/mcp   (Streamable HTTP, stateless)

   Same door as the REST data API: it sits behind ceoAgentKey, so every
   call needs "Authorization: Bearer <the admin's CEO Agent API key>" and
   can only ever see that admin's restaurants (req.ceoAgent).

   Read-only by construction: every tool is marked readOnlyHint, and the
   CEO Agent only exposes tools that are. The list tools reuse the REST
   handlers from ceoAgentData.Controller.js, so the queries and field
   shapes stay in one place.
========================================================= */

const CURRENCY = String(process.env.CEO_AGENT_CURRENCY || "INR").trim() || "INR";
const TIMEZONE = String(process.env.CEO_AGENT_TIMEZONE || "Asia/Kolkata").trim() || "Asia/Kolkata";
const MAX_LIMIT = 100;
const MAX_RANGE_DAYS = 366;
const SALE_STATUS = { PAID: "paid", PENDING: "placed", VOID: "cancelled" };

const text = (value) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
});
const failure = (message) => ({ content: [{ type: "text", text: message }], isError: true });

// Runs an existing Express data handler and captures the JSON it would have sent.
const runHandler = (handler, ceoAgent, query) =>
  new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({ status: this.statusCode, body });
        return this;
      },
    };
    handler({ query, ceoAgent }, res, reject);
  });

const withoutBlanks = (args) =>
  Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined && value !== ""));

// Wraps a tool body so a thrown error becomes a tool error, not a dropped request.
const safe = (name, fn) => async (args) => {
  try {
    return await fn(args);
  } catch (err) {
    if (err?.status) return failure(err.message);
    console.error(`[ceo-agent-mcp] ${name} failed:`, err);
    return failure("The ERP could not complete this request.");
  }
};

const proxyList = (name, handler, defaultLimit, ceoAgent) =>
  safe(name, async (args) => {
    const { status, body } = await runHandler(handler, ceoAgent, withoutBlanks({ ...args, limit: args.limit ?? defaultLimit }));
    return status >= 400 ? failure(body?.message || "Request failed") : text(body);
  });

const parseDate = (value, label) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw Object.assign(new Error(`Invalid ${label}`), { status: 400 });
  return date;
};

// All of the admin's restaurants, or just the one asked for.
const scoped = (ceoAgent, restaurantId) => {
  if (!restaurantId) return ceoAgent.restaurantIds;
  const match = ceoAgent.restaurantIds.find((id) => String(id) === String(restaurantId));
  if (!match) throw Object.assign(new Error("Restaurant not found"), { status: 404 });
  return [match];
};

const listArgs = {
  restaurantId: z
    .string()
    .optional()
    .describe("Limit to one restaurant (an id from list_restaurants). Omit for all of this account's restaurants."),
  page: z.number().int().min(1).optional().describe("Page number, starting at 1."),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Rows per page (max ${MAX_LIMIT}).`),
};

function buildServer(ceoAgent) {
  const server = new McpServer(
    { name: "fnb-erp", version: "1.0.0" },
    {
      instructions:
        "Read-only restaurant ERP data for one account: restaurants, customers, billed sales and the menu. " +
        `Amounts are in ${CURRENCY}. Call list_restaurants first to get restaurant ids. ` +
        "For totals over a period use get_sales_summary instead of paging through get_sales.",
    },
  );
  const annotations = { readOnlyHint: true, openWorldHint: false };

  server.registerTool(
    "list_restaurants",
    {
      description: "List this account's restaurants (id and name). Use the ids to narrow the other tools to one restaurant.",
      inputSchema: {},
      annotations,
    },
    safe("list_restaurants", async () => {
      const rows = await Restaurant.find({ _id: { $in: ceoAgent.restaurantIds } }).lean();
      return text({
        restaurants: rows.map((r) => ({ id: String(r._id), name: r.name ?? r.restaurantName ?? r.title ?? "" })),
      });
    }),
  );

  server.registerTool(
    "get_customers",
    {
      description:
        "Customers with their visit count, total spend and segment (new or repeat), identified by phone or email. Paginated; the result says whether more pages exist.",
      inputSchema: {
        ...listArgs,
        updated_since: z.string().optional().describe("Only customers active since this ISO date or timestamp, e.g. 2026-10-01."),
      },
      annotations,
    },
    proxyList("get_customers", listCustomers, 50, ceoAgent),
  );

  server.registerTool(
    "get_sales",
    {
      description:
        "Individual billed sales (one row per bill, with items, amount, status and payment method). Paginated and detailed — for totals over a period use get_sales_summary.",
      inputSchema: {
        ...listArgs,
        since: z.string().optional().describe("Only bills updated since this ISO date or timestamp, e.g. 2026-10-01."),
      },
      annotations,
    },
    proxyList("get_sales", listOrders, 25, ceoAgent),
  );

  server.registerTool(
    "get_menu",
    {
      description:
        "Menu items with price, category, course type and whether each is currently available. Paginated. Items are made to order, so there is no stock count.",
      inputSchema: listArgs,
      annotations,
    },
    proxyList("get_menu", listProducts, 50, ceoAgent),
  );

  server.registerTool(
    "get_sales_summary",
    {
      description:
        `Sales totals for a period: revenue (paid bills), bill counts and amounts by status, average bill, and revenue per day. Defaults to the last 30 days. Amounts are in ${CURRENCY}.`,
      inputSchema: {
        restaurantId: listArgs.restaurantId,
        from: z.string().optional().describe("Start, inclusive. YYYY-MM-DD or an ISO timestamp. Default: 30 days ago."),
        to: z.string().optional().describe("End, exclusive. YYYY-MM-DD or an ISO timestamp. Default: now."),
        timezone: z
          .string()
          .optional()
          .describe(`IANA timezone used to split revenue into days. Default: ${TIMEZONE}.`),
      },
      annotations,
    },
    safe("get_sales_summary", async ({ restaurantId, from, to, timezone }) => {
      const restaurants = scoped(ceoAgent, restaurantId);
      const end = to ? parseDate(to, "to") : new Date();
      const start = from ? parseDate(from, "from") : new Date(end.getTime() - 30 * 86_400_000);
      if (start >= end) return failure("`from` must be before `to`.");
      if (end - start > MAX_RANGE_DAYS * 86_400_000) return failure(`The period can be at most ${MAX_RANGE_DAYS} days.`);

      const zone = timezone || TIMEZONE;
      try {
        new Intl.DateTimeFormat("en", { timeZone: zone });
      } catch {
        return failure(`Unknown timezone: ${zone}`);
      }

      const [result] = await Bill.aggregate([
        { $match: { restaurant: { $in: restaurants }, createdAt: { $gte: start, $lt: end } } },
        {
          $facet: {
            byStatus: [{ $group: { _id: "$paymentStatus", bills: { $sum: 1 }, amount: { $sum: "$totalAmount" } } }],
            daily: [
              { $match: { paymentStatus: "PAID" } },
              {
                $group: {
                  _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: zone } },
                  revenue: { $sum: "$totalAmount" },
                  bills: { $sum: 1 },
                },
              },
              { $sort: { _id: 1 } },
            ],
          },
        },
      ]);

      const byStatus = { paid: { bills: 0, amount: 0 }, placed: { bills: 0, amount: 0 }, cancelled: { bills: 0, amount: 0 } };
      for (const row of result?.byStatus || []) {
        const key = SALE_STATUS[row._id] || "placed";
        byStatus[key].bills += row.bills;
        byStatus[key].amount += row.amount;
      }
      const { bills: paidBills, amount: revenue } = byStatus.paid;

      return text({
        restaurantIds: restaurants.map(String),
        from: start.toISOString(),
        to: end.toISOString(),
        timezone: zone,
        currency: CURRENCY,
        revenue,
        paidBills,
        averageBill: paidBills ? Math.round((revenue / paidBills) * 100) / 100 : 0,
        byStatus,
        daily: (result?.daily || []).map((d) => ({ date: d._id, revenue: d.revenue, bills: d.bills })),
      });
    }),
  );

  return server;
}

/* ===============================
   POST /mcp
=============================== */
export const handleMcp = async (req, res) => {
  // A fresh server per request: stateless, nothing to leak between callers.
  const server = buildServer(req.ceoAgent);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[ceo-agent-mcp] request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
};

// Stateless server: no sessions to resume (GET) or terminate (DELETE).
export const mcpMethodNotAllowed = (_req, res) => {
  res
    .status(405)
    .set("Allow", "POST")
    .json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
};
