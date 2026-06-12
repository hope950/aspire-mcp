# Aspire MCP — Setup Guide

This guide walks you through deploying your Aspire connector so it works inside Cowork.
No coding knowledge required — just follow the steps in order.

**Total time: about 15–20 minutes.**

---

## What you'll need before starting

- Your **Aspire API credentials** (Client ID and Secret)
  - In Aspire, go to: **Administration → Application → API**
  - Create a new credential if you haven't already
  - Copy the **Client ID** and **Secret** somewhere safe

- A free **GitHub account** → [github.com](https://github.com)
- A **Render account** (free to create) → [render.com](https://render.com)

---

## Step 1 — Put the files on GitHub

GitHub is where we store the server code. Render will pull from it automatically.

1. Go to [github.com](https://github.com) and sign in (or create a free account)
2. Click the **+** button in the top-right → **New repository**
3. Name it `aspire-mcp`
4. Leave everything else as the defaults and click **Create repository**
5. On the next screen, click **uploading an existing file**
6. Drag and drop these four files from your computer into the upload area:
   - `server.js`
   - `package.json`
   - `render.yaml`
   - `SETUP.md` (this file, optional)
7. Click **Commit changes**

Your code is now on GitHub. ✓

---

## Step 2 — Deploy to Render

Render is the cloud service that will run your server.

1. Go to [render.com](https://render.com) and click **Get Started for Free**
2. Sign up using **GitHub** (this links the two accounts automatically)
3. On the Render dashboard, click **New +** → **Web Service**
4. Under "Connect a repository", find **aspire-mcp** and click **Connect**
5. Render will auto-detect the settings from `render.yaml`. Confirm these look right:
   - **Name:** aspire-mcp
   - **Environment:** Node
   - **Build command:** `npm install`
   - **Start command:** `node server.js`
6. Scroll down to **Instance Type**:
   - Choose **Starter ($7/month)** for an always-on server ← recommended
   - Or choose **Free** if you want to try it first (will be slow to wake up)
7. Click **Create Web Service**

Render will now build and deploy your server. This takes about 2–3 minutes.
You'll see a log with green "Deploy successful" when it's done. ✓

---

## Step 3 — Add your Aspire credentials

Your API credentials are entered here — not in the code — so they stay private.

1. In Render, click on your **aspire-mcp** service
2. Click **Environment** in the left sidebar
3. Click **Add Environment Variable** and add these two:

   | Key | Value |
   |-----|-------|
   | `ASPIRE_CLIENT_ID` | *(paste your Aspire Client ID)* |
   | `ASPIRE_SECRET` | *(paste your Aspire Secret)* |

4. Click **Save Changes**
5. Render will automatically restart the server with the new credentials

---

## Step 4 — Copy your server URL

1. At the top of your Render service page, you'll see a URL like:
   `https://aspire-mcp.onrender.com`
2. Copy this URL

---

## Step 5 — Add to Cowork

1. Open **Cowork** (the Claude desktop app)
2. Go to **Settings** → **Connections** (or **MCP Servers**)
3. Click **Add MCP Server** or **Add Connection**
4. Enter:
   - **Name:** Aspire
   - **URL:** `https://aspire-mcp.onrender.com/mcp`
     *(your URL from Step 4, with `/mcp` at the end)*
   - **Transport:** Streamable HTTP
5. Save

Aspire should now appear as a connected tool in Cowork, just like Gmail or QuickBooks. ✓

---

## Step 6 — Test it

In Cowork, try asking:

> "List my open work tickets from Aspire"

or

> "Show me all opportunities with a bid due date this month"

---

## Troubleshooting

**"Invalid API credentials" error**
→ Double-check your `ASPIRE_CLIENT_ID` and `ASPIRE_SECRET` in Render's Environment settings.
   Make sure there are no extra spaces.

**Server takes 30+ seconds to respond (free tier)**
→ The free tier "sleeps" when not in use. Upgrade to Starter ($7/month) in Render for instant response.

**Can't find the connection settings in Cowork**
→ Ask Claude: "How do I add a custom MCP server to Cowork?" and it will walk you through it.

---

## Available tools (what you can ask Claude to do)

Once connected, Claude can use these Aspire tools:

| Tool | What it does |
|------|-------------|
| `list_work_tickets` | Search work tickets by status, date, branch, crew leader |
| `list_work_ticket_visits` | See what's scheduled by route and date |
| `list_work_ticket_times` | View labor hours logged per ticket |
| `log_work_ticket_time` | Add a time entry to a work ticket |
| `mark_work_tickets_reviewed` | Mark tickets reviewed |
| `list_opportunities` | Search jobs, estimates, and contracts |
| `create_opportunity` | Create a new job or estimate |
| `update_opportunity` | Update status, dates, or dollar amounts |
| `list_opportunity_services` | See services on a job |
| `list_properties` | Search service locations |
| `create_property` | Add a new service location |
| `list_contacts` | Search customers, employees, leads |
| `create_contact` | Add a new contact |
| `list_routes` | See all crew routes and assignments |
| `list_clock_times` | View employee clock-in/out records |
| `list_invoices` | Search invoices (e.g. unpaid, overdue) |
| `list_payments` | View payment records |
| `list_tasks` | See tasks in Aspire |
| `create_task` | Create a task linked to a job, property, or ticket |
| `list_activities` | View CRM activity history |
| `list_issues` | View issues |
| `create_issue` | Create an issue |
| `list_branches` | Get branch IDs and names |
| `list_divisions` | Get division IDs and names |
| `list_users` | Get user IDs and names |
| `list_services` | Browse the service catalog |
| `list_catalog_items` | Browse materials/price list |
| `list_equipment` | View equipment records |
| `get_api_version` | Health check |

All list tools support filtering, sorting, and pagination using standard Aspire field names.
