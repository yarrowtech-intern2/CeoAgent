# F&B ERP → CEO Agent over MCP

`ceoAgentMcp.Controller.js` adds one endpoint to the **F&B backend** (not this repo):

    POST https://api.efnbmms.com/api/ceo-agent/mcp

It sits behind the existing `ceoAgentKey` middleware, so it uses the same
`Authorization: Bearer <key>` and the same per-admin restaurant scoping as the
REST data API. The list tools call the existing `listCustomers`, `listOrders`
and `listProducts` handlers, so queries and field shapes stay in one place.

| Tool | What it returns |
|---|---|
| `list_restaurants` | The account's restaurants (id, name) |
| `get_customers` | Customers: visits, spend, segment (paginated) |
| `get_sales` | Individual bills with items (paginated) |
| `get_menu` | Menu items with price and availability (paginated) |
| `get_sales_summary` | Revenue, bill counts by status, average bill, revenue per day |

Every tool is marked `readOnlyHint`, which is what CEO Agent requires before
it exposes a tool to an agent.

## Add it to the F&B backend

1. Copy `ceoAgentMcp.Controller.js` to `Backend/controllers/`.
2. In `Backend/routes/ceoAgent.routes.js` add the import, and the three routes
   after `router.use(ceoAgentKey);`:

   ```js
   import { handleMcp, mcpMethodNotAllowed } from "../controllers/ceoAgentMcp.Controller.js";

   router.post("/mcp", handleMcp);
   router.get("/mcp", mcpMethodNotAllowed);
   router.delete("/mcp", mcpMethodNotAllowed);
   ```

3. `cd Backend && npm install @modelcontextprotocol/sdk zod`
4. Commit, push, then on the VPS: `git pull`, `npm ci` in `Backend`,
   `pm2 restart fandb-backend`.

Optional env (in the F&B backend's `.env`): `CEO_AGENT_CURRENCY` (already
used, default `INR`) and `CEO_AGENT_TIMEZONE` (used to split revenue into days,
default `Asia/Kolkata`).

## Check it before connecting CEO Agent

Type the key into your own shell; don't paste it anywhere else.

```bash
KEY='...'
curl -s https://api.efnbmms.com/api/ceo-agent/mcp \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

You should see five tools. Then try a real call:

```bash
curl -s https://api.efnbmms.com/api/ceo-agent/mcp \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_restaurants","arguments":{}}}'
```

Check that `list_restaurants` returns real names. It reads `name`, falling back
to `restaurantName` then `title`, because the Restaurant model wasn't visible
when this was written. Then run `get_sales_summary` and compare its revenue with
a period you know in the admin dashboard.

## Connect CEO Agent

In CEO Agent: **Accounts → Connected systems → Add system**

- Name: e.g. `Restaurant ERP`
- MCP URL: `https://api.efnbmms.com/api/ceo-agent/mcp`
- Data access key: from the ERP's *Data access key* page

The ERP stores only a hash of the key, so an existing key can't be shown again:
click **Create a new key** and copy it immediately. An admin has one key, so
creating a new one stops anything still using the old key.
