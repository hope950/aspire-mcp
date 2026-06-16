/**
 * Aspire MCP Server
 * Exposes Aspire business management data as MCP tools for Cowork / Claude Code.
 *
 * Required environment variables:
 *   ASPIRE_CLIENT_ID  — your Aspire API Client ID
 *   ASPIRE_SECRET     — your Aspire API Secret
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { z } from "zod";
import { randomUUID } from "crypto";

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const ASPIRE_BASE = "https://cloud-api.youraspire.com";
const CLIENT_ID = process.env.ASPIRE_CLIENT_ID;
const SECRET = process.env.ASPIRE_SECRET;
const PORT = process.env.PORT || 3000;

if (!CLIENT_ID || !SECRET) {
  console.error("ERROR: ASPIRE_CLIENT_ID and ASPIRE_SECRET environment variables are required.");
  process.exit(1);
}

// ─── TOKEN MANAGEMENT ────────────────────────────────────────────────────────

let _token = null;
let _refreshToken = null;
let _tokenExpiry = 0;

async function getToken() {
  const now = Date.now();

  // Return cached token if still valid (with 5-minute buffer)
  if (_token && now < _tokenExpiry - 5 * 60 * 1000) return _token;

  // Try refresh token first
  if (_refreshToken) {
    try {
      const r = await fetch(`${ASPIRE_BASE}/Authorization/RefreshToken`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ RefreshToken: _refreshToken }),
      });
      if (r.ok) {
        const d = await r.json();
        _token = d.Token;
        _refreshToken = d.RefreshToken;
        _tokenExpiry = now + 23 * 60 * 60 * 1000; // 23 hours
        console.log("Token refreshed successfully");
        return _token;
      }
    } catch (e) {
      console.warn("Refresh token failed, falling back to full auth:", e.message);
    }
  }

  // Full authentication
  const r = await fetch(`${ASPIRE_BASE}/Authorization`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ClientId: CLIENT_ID, Secret: SECRET }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Aspire authentication failed (${r.status}): ${body}`);
  }
  const d = await r.json();
  _token = d.Token;
  _refreshToken = d.RefreshToken;
  _tokenExpiry = now + 23 * 60 * 60 * 1000;
  console.log("Authenticated with Aspire API");
  return _token;
}

// ─── HTTP HELPERS ─────────────────────────────────────────────────────────────

async function apiGet(path, params = {}) {
  const token = await getToken();
  const url = new URL(`${ASPIRE_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const r = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}: ${await r.text()}`);
  return r.json();
}

async function apiPost(path, body) {
  const token = await getToken();
  const r = await fetch(`${ASPIRE_BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST ${path} → ${r.status}: ${await r.text()}`);
  return r.json();
}

async function apiPut(path, body) {
  const token = await getToken();
  const r = await fetch(`${ASPIRE_BASE}${path}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PUT ${path} → ${r.status}: ${await r.text()}`);
  return r.json();
}

// ─── RESPONSE HELPERS ────────────────────────────────────────────────────────

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(e) {
  console.error("Tool error:", e.message);
  return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
}

// OData param builder — only includes non-empty values
function odata({ filter, select, orderby, expand, top, skip } = {}) {
  return {
    "$filter": filter,
    "$select": select,
    "$orderby": orderby,
    "$expand": expand,
    "$top": top ?? 50,
    "$skip": skip,
  };
}

// ─── BUILD SERVER (called fresh per MCP session) ──────────────────────────────

function buildServer() {
  const server = new McpServer({
    name: "aspire",
    version: "1.0.0",
    description: "Aspire business management — work tickets, jobs, estimates, contacts, crew, invoices",
  });

  // ── WORK TICKETS ──────────────────────────────────────────────────────────

  server.tool(
    "list_work_tickets",
    `List work tickets. Key fields: WorkTicketID, WorkTicketNumber, WorkTicketStatus,
    AnticStartDate, ScheduledStartDate, CompleteDate, CrewLeaderName,
    HoursEst, HoursAct, Price, InvoicedAmount, OpportunityID, BranchName.
    Filter examples: "WorkTicketStatus eq 'Open'", "BranchName eq 'Main'",
    "AnticStartDate ge 2024-01-01 and AnticStartDate le 2024-12-31".`,
    {
      filter: z.string().optional().describe("OData $filter expression"),
      select: z.string().optional().describe("Comma-separated field names to return"),
      orderby: z.string().optional().describe("Sort field, e.g. 'AnticStartDate desc'"),
      top: z.number().optional().describe("Max results (default 50)"),
      skip: z.number().optional().describe("Records to skip for pagination"),
      expand: z.string().optional().describe("Nested collections to include, e.g. 'WorkTicketRevenues'"),
    },
    async (args) => {
      try { return ok(await apiGet("/WorkTickets", odata(args))); }
      catch (e) { return fail(e); }
    }
  );

  server.tool(
    "list_work_ticket_visits",
    `List scheduled visits for work tickets. Key fields: WorkTicketVisitID, WorkTicketID,
    WorkTicketNumber, RouteID, RouteName, ScheduledDate, SequenceNum, Hours.
    Use to see what's scheduled for a specific date or route.
    Filter example: "ScheduledDate ge 2024-06-01 and ScheduledDate le 2024-06-30".`,
    {
      filter: z.string().optional(),
      select: z.string().optional(),
      orderby: z.string().optional().describe("e.g. 'ScheduledDate asc'"),
      top: z.number().optional(),
      skip: z.number().optional(),
    },
    async (args) => {
      try { return ok(await apiGet("/WorkTicketVisits", odata(args))); }
      catch (e) { return fail(e); }
    }
  );

  server.tool(
    "list_work_ticket_times",
    `List labor time entries logged against work tickets. Key fields: WorkTicketTimeID,
    WorkTicketID, ContactID, ContactName, WorkTicketTimeDate, StartTime, EndTime, Hours, OTHours,
    RouteID, RouteName, CrewLeaderContactName, BranchName.
    Filter example: "ContactID eq 42" or "WorkTicketTimeDate ge 2024-06-01".`,
    {
      filter: z.string().optional(),
      select: z.string().optional(),
      orderby: z.string().optional(),
      top: z.number().optional(),
      skip: z.number().optional(),
    },
    async (args) => {
      try { return ok(await apiGet("/WorkTicketTimes", odata(args))); }
      catch (e) { return fail(e); }
    }
  );

  server.tool(
    "log_work_ticket_time",
    "Log a labor time entry against a work ticket.",
    {
      workTicketId: z.number().describe("WorkTicketID to log time against"),
      contactId: z.number().describe("ContactID of the employee"),
      startTime: z.string().describe("ISO 8601 datetime, e.g. '2024-06-12T08:00:00'"),
      endTime: z.string().describe("ISO 8601 datetime, e.g. '2024-06-12T16:00:00'"),
      routeId: z.number().optional().describe("RouteID if applicable"),
      crewLeaderContactId: z.number().optional(),
    },
    async ({ workTicketId, contactId, startTime, endTime, routeId, crewLeaderContactId }) => {
      try {
        return ok(await apiPost("/WorkTicketTimes", {
          WorkTicketID: workTicketId, ContactID: contactId,
          StartTime: startTime, EndTime: endTime,
          RouteID: routeId, CrewLeaderContactID: crewLeaderContactId,
        }));
      } catch (e) { return fail(e); }
    }
  );

  server.tool(
    "mark_work_tickets_reviewed",
    "Mark one or more work tickets as reviewed.",
    {
      workTicketIds: z.array(z.number()).describe("Array of WorkTicketIDs to mark reviewed"),
    },
    async ({ workTicketIds }) => {
      try {
        return ok(await apiPost("/WorkTicketStatus/MarkWorkTicketAsReviewed", { WorkTicketIDs: workTicketIds }));
      } catch (e) { return fail(e); }
    }
  );

  server.tool(
    "get_work_ticket_visit_notes",
    "Get visit notes logged during work ticket visits.",
    {
      filter: z.string().optional().describe("OData $filter, e.g. 'WorkTicketID eq 123'"),
      top: z.number().optional(),
      skip: z.number().optional(),
    },
    async (args) => {
      try { return ok(await apiGet("/WorkTicketVisitNotes", odata(args))); }
      catch (e) { return fail(e); }
    }
  );

  // ── OPPORTUNITIES (Jobs / Estimates / Contracts) ───────────────────────────

  server.tool(
    "list_opportunities",
    `List opportunities — jobs, estimates, and contracts. Key fields: OpportunityID,
    OpportunityNumber, OpportunityName, OpportunityType, OpportunityStatus,
    PropertyName, SalesRepContactName, BranchName, DivisionName,
    StartDate, EndDate, BidDueDate, EstimatedDollars, WonDollars,
    ActualGrossMarginPercent, PercentComplete.
    OpportunityType values: 'Contract', 'Bid', 'Work Order', 'Recurring'.
    Filter examples: "OpportunityStatus eq 'Open'", "BidDueDate le 2024-12-31".`,
    {
      filter: z.string().optional(),
      select: z.string().optional(),
      orderby: z.string().optional(),
      top: z.number().optional(),
      skip: z.number().optional(),
      expand: z.string().optional().describe("e.g. 'OpportunityRevisions,ScheduleOfValues'"),
    },
    async (args) => {
      try { return ok(await apiGet("/Opportunities", odata(args))); }
      catch (e) { return fail(e); }
    }
  );

  server.tool(
    "create_opportunity",
    "Create a new opportunity (job or estimate).",
    {
      opportunityName: z.string().describe("Name of the opportunity"),
      opportunityType: z.string().describe("'Contract', 'Bid', 'Work Order', or 'Recurring'"),
      propertyId: z.number().describe("PropertyID for the service location"),
      opportunityStatusId: z.number().describe("OpportunityStatusID (get from list_opportunity_statuses)"),
      salesRepId: z.number().describe("ContactID of the sales rep"),
      divisionId: z.number().describe("DivisionID"),
      branchId: z.number().optional(),
      startDate: z.string().optional().describe("ISO date, e.g. '2024-06-01'"),
      endDate: z.string().optional(),
      bidDueDate: z.string().optional(),
      estimatedDollars: z.number().optional(),
      budgetedDollars: z.number().optional(),
      customerPoNum: z.string().max(20).optional(),
      customerContractNum: z.string().max(40).optional(),
    },
    async (args) => {
      try {
        return ok(await apiPost("/Opportunities", {
          OpportunityName: args.opportunityName,
          OpportunityType: args.opportunityType,
          PropertyID: args.propertyId,
          OpportunityStatusID: args.opportunityStatusId,
          SalesRepID: args.salesRepId,
          DivisionID: args.divisionId,
          BranchID: args.branchId,
          StartDate: args.startDate,
          EndDate: args.endDate,
          BidDueDate: args.bidDueDate,
          EstimatedDollars: args.estimatedDollars,
          BudgetedDollars: args.budgetedDollars,
          CustomerPONum: args.customerPoNum,
          CustomerContractNum: args.customerContractNum,
        }));
      } catch (e) { return fail(e); }
    }
  );

  server.tool(
    "update_opportunity",
    "Update an existing opportunity.",
    {
      opportunityId: z.number(),
      opportunityStatusId: z.number().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      estimatedDollars: z.number().optional(),
      probability: z.number().min(0).max(100).optional(),
      bidDueDate: z.string().optional(),
      renewalDate: z.string().optional(),
    },
    async (args) => {
      try {
        return ok(await apiPut("/Opportunities", {
          OpportunityID: args.opportunityId,
          OpportunityStatusID: args.opportunityStatusId,
          StartDate: args.startDate,
          EndDate: args.endDate,
          EstimatedDollars: args.estimatedDollars,
          Probability: args.probability,
          BidDueDate: args.bidDueDate,
          RenewalDate: args.renewalDate,
        }));
      } catch (e) { return fail(e); }
    }
  );

  server.tool(
    "list_opportunity_services",
    `List services attached to opportunities. Key fields: OpportunityServiceID, OpportunityID,
    ServiceID, DisplayName, Occur, AsNeeded, PerPrice, ExtendedPrice, ExtendedHours,
    OpportunityServiceStatus, OpportunityServiceRoutes.`,
    {
      filter: z.string().optional().describe("e.g. 'OpportunityID eq 456'"),
      select: z.string().optional(),
      orderby: z.string().optional(),
      top: z.number().optional(),
      skip: z.number().optional(),
      expand: z.string().optional(),
    },
    async (args) => {
      try { return ok(await apiGet("/OpportunityServices", odata(args))); }
      catch (e) { return fail(e); }
    }
  );

  // ── PROPERTIES (Service Locations) ────────────────────────────────────────

  server.tool(
    "list_properties",
    `List properties (service locations / customer sites). Key fields: PropertyID, PropertyName,
    PropertyAddressLine1, PropertyAddressCity, PropertyAddressStateProvinceCode, PropertyAddressZipCode,
    BranchName, AccountOwnerContactName, Active, Note, ProductionNote.
    Expand 'PropertyContacts' to get linked contacts.
    Filter example: "Active eq true", "BranchID eq 2".`,
    {
      filter: z.string().optional(),
      select: z.string().optional(),
      orderby: z.string().optional(),
      top: z.number().optional(),
      skip: z.number().optional(),
      expand: z.string().optional().describe("e.g. 'PropertyContacts,PropertyTags'"),
    },
    async (args) => {
      try { return ok(await apiGet("/Properties", odata(args))); }
      catch (e) { return fail(e); }
    }
  );

  server.tool(
    "create_property",
    "Create a new property (service location).",
    {
      propertyName: z.string(),
      branchId: z.number(),
      addressLine1: z.string().optional(),
      city: z.string().optional(),
      stateProvinceCode: z.string().max(3).optional(),
      zipCode: z.string().optional(),
      accountOwnerContactId: z.number().optional(),
      primaryContactId: z.number().optional(),
      note: z.string().optional(),
      productionNote: z.string().optional(),
      active: z.boolean().optional().default(true),
      taxJurisdictionId: z.number().optional(),
    },
    async (args) => {
      try {
        return ok(await apiPost("/Properties", {
          PropertyName: args.propertyName,
          BranchID: args.branchId,
          AddressLine1: args.addressLine1,
          City: args.city,
          StateProvinceCode: args.stateProvinceCode,
          ZipCode: args.zipCode,
          AccountOwnerContactID: args.accountOwnerContactId,
          PrimaryContactID: args.primaryContactId,
          Note: args.note,
          ProductionNote: args.productionNote,
          Active: args.active,
          TaxJurisdictionID: args.taxJurisdictionId,
        }));
      } catch (e) { return fail(e); }
    }
  );

  server.tool(
    "update_property",
    "Update an existing property.",
    {
      propertyId: z.number(),
      propertyName: z.string().optional(),
      note: z.string().optional(),
      productionNote: z.string().optional(),
      active: z.boolean().optional(),
      accountOwnerContactId: z.number().optional(),
    },
    async (args) => {
      try {
        return ok(await apiPut("/Properties", {
          PropertyID: args.propertyId,
          PropertyName: args.propertyName,
          Note: args.note,
          ProductionNote: args.productionNote,
          Active: args.active,
          AccountOwnerContactID: args.accountOwnerContactId,
        }));
      } catch (e) { return fail(e); }
    }
  );

  // ── CONTACTS ──────────────────────────────────────────────────────────────

  server.tool(
    "list_contacts",
    `List contacts — customers, employees, leads, subcontractors. Key fields:
    ContactID, FirstName, LastName, ContactTypeName, Email, MobilePhone, OfficePhone,
    CompanyName, BranchName, Active, ProspectRating (A/B/C/D).
    Filter examples: "Active eq true", "ContactTypeName eq 'Customer'".`,
    {
      filter: z.string().optional(),
      select: z.string().optional(),
      orderby: z.string().optional().describe("e.g. 'LastName asc'"),
      top: z.number().optional(),
      skip: z.number().optional(),
      expand: z.string().optional(),
    },
    async (args) => {
      try { return ok(await apiGet("/Contacts", odata(args))); }
      catch (e) { return fail(e); }
    }
  );

  server.tool(
    "create_contact",
    "Create a new contact (customer, employee, or lead).",
    {
      firstName: z.string(),
      lastName: z.string(),
      contactTypeId: z.number().optional(),
      email: z.string().optional(),
      mobilePhone: z.string().optional(),
      officePhone: z.string().optional(),
      companyId: z.number().optional(),
      branchId: z.number().optional(),
      active: z.boolean().optional().default(true),
      notes: z.string().optional(),
      prospectRating: z.enum(["A", "B", "C", "D"]).optional(),
    },
    async (args) => {
      try {
        return ok(await apiPost("/Contacts", {
          Contact: {
            FirstName: args.firstName,
            LastName: args.lastName,
            ContactTypeID: args.contactTypeId,
            Email: args.email,
            MobilePhone: args.mobilePhone,
            OfficePhone: args.officePhone,
            CompanyID: args.companyId,
            BranchID: args.branchId,
            Active: args.active,
            Notes: args.notes,
            ProspectRating: args.prospectRating,
          },
        }));
      } catch (e) { return fail(e); }
    }
  );

  server.tool(
    "update_contact",
    "Update an existing contact.",
    {
      contactId: z.number(),
      email: z.string().optional(),
      mobilePhone: z.string().optional(),
      officePhone: z.string().optional(),
      notes: z.string().optional(),
      active: z.boolean().optional(),
      prospectRating: z.enum(["A", "B", "C", "D"]).optional(),
    },
    async (args) => {
      try {
        return ok(await apiPut("/Contacts", {
          Contact: {
            ContactID: args.contactId,
            Email: args.email,
            MobilePhone: args.mobilePhone,
            OfficePhone: args.officePhone,
            Notes: args.notes,
            Active: args.active,
            ProspectRating: args.prospectRating,
          },
          ContactID: args.contactId,
        }));
      } catch (e) { return fail(e); }
    }
  );

  // ── ROUTES (Crew Scheduling) ───────────────────────────────────────────────

  server.tool(
    "list_routes",
    `List crew routes (scheduling). Key fields: RouteID, RouteName, BranchName, DivisionName,
    CrewLeaderContactName, Hours, Color, Active, RouteSize, ManagerName,
    RouteProperties (expand to see assigned properties),
    RouteServices (expand to see assigned services).
    Filter example: "Active eq true", "BranchID eq 1".`,
    {
      filter: z.string().optional(),
      select: z.string().optional(),
      top: z.number().optional(),
      skip: z.number().optional(),
      expand: z.string().optional().describe("e.g. 'RouteProperties,RouteServices,RouteServiceTypes'"),
    },
    async (args) => {
      try { return ok(await apiGet("/Routes", odata(args))); }
      catch (e) { return fail(e); }
    }
  );

  server.tool(
    "list_clock_times",
    `List employee clock-in/out records. Key fields: ClockTimeID, ContactID, ContactName,
    ClockStart, ClockEnd, BreakTime, AcceptedDateTime.
    Filter example: "ContactID eq 42" or "ClockStart ge 2024-06-01".`,
    {
      filter: z.string().optional(),
      select: z.string().optional(),
      orderby: z.string().optional(),
      top: z.number().optional(),
      skip: z.number().optional(),
    },
    async (args) => {
      try { return ok(await apiGet("/ClockTimes", odata(args))); }
      catch (e) { return fail(e); }
    }
  );

  // ── INVOICES & PAYMENTS ────────────────────────────────────────────────────

  server.tool(
    "list_invoices",
    `List invoices. Key fields: InvoiceID, InvoiceNumber, InvoiceDate, DueDate,
    PropertyName, BillingContactName, Amount, AmountRemaining, OrigAmount,
    PaymentTermsName, EmailStatus, CompanyName.
    Filter examples: "AmountRemaining gt 0" (unpaid), "DueDate le 2024-12-31".`,
    {
      filter: z.string().optional(),
      select: z.string().optional(),
      orderby: z.string().optional().describe("e.g. 'DueDate asc'"),
      top: z.number().optional(),
      skip: z.number().optional(),
      expand: z.string().optional().describe("e.g. 'InvoiceOpportunities'"),
    },
    async (args) => {
      try { return ok(await apiGet("/Invoices", odata(args))); }
      catch (e) { return fail(e); }
    }
  );

  server.tool(
    "list_payments",
    `List payment records. Key fields: PaymentID, PaymentType, PaymentReference,
    PaymentAmount, PaymentDate, ContactName, PropertyName, BranchName,
    PaymentCategoryName, PaymentNote.`,
    {
      filter: z.string().optional(),
      select: z.string().optional(),
      orderby: z.string().optional(),
      top: z.number().optional(),
      skip: z.number().optional(),
    },
    async (args) => {
      try { return ok(await apiGet("/Payments", odata(args))); }
      catch (e) { return fail(e); }
    }
  );

  // ── TASKS & ACTIVITIES ─────────────────────────────────────────────────────

  server.tool(
    "list_tasks",
    `List tasks in Aspire. Key fields: Subject, AssignedTo, DueDate, StartDate,
    Notes, Priority (Low/Medium/High), OpportunityID, PropertyID, WorkTicketID.`,
    {
      filter: z.string().optional(),
      select: z.string().optional(),
      orderby: z.string().optional().describe("e.g. 'DueDate asc'"),
      top: z.number().optional(),
      skip: z.number().optional(),
    },
    async (args) => {
      try { return ok(await apiGet("/Tasks", odata(args))); }
      catch (e) { return fail(e); }
    }
  );

  server.tool(
    "create_task",
    "Create a task in Aspire, optionally linked to an opportunity, property, or work ticket.",
    {
      subject: z.string().max(200).describe("Task title"),
      assignedTo: z.number().describe("ContactID of the person to assign to"),
      dueDate: z.string().optional().describe("ISO date, e.g. '2024-06-15'"),
      startDate: z.string().optional(),
      notes: z.string().optional(),
      priority: z.enum(["Low", "Medium", "High"]).optional(),
      opportunityId: z.number().optional(),
      propertyId: z.number().optional(),
      workTicketId: z.number().optional(),
    },
    async (args) => {
      try {
        return ok(await apiPost("/Tasks", {
          Subject: args.subject,
          AssignedTo: args.assignedTo,
          DueDate: args.dueDate,
          StartDate: args.startDate,
          Notes: args.notes,
          Priority: args.priority,
          OpportunityID: args.opportunityId,
          PropertyID: args.propertyId,
          WorkTicketID: args.workTicketId,
        }));
      } catch (e) { return fail(e); }
    }
  );

  server.tool(
    "list_activities",
    `List CRM activities (notes, calls, emails, meetings, tasks, issues).
    Key fields: ActivityID, ActivityType, Status, Subject, Notes, Priority,
    StartDate, DueDate, CompleteDate, PropertyID, OpportunityID, WorkTicketID,
    ActivityCategoryName.`,
    {
      filter: z.string().optional(),
      select: z.string().optional(),
      orderby: z.string().optional(),
      top: z.number().optional(),
      skip: z.number().optional(),
    },
    async (args) => {
      try { return ok(await apiGet("/Activities", odata(args))); }
      catch (e) { return fail(e); }
    }
  );

  // ── ISSUES ─────────────────────────────────────────────────────────────────

  server.tool(
    "list_issues",
    "List issues (CRM issue tracking). Similar fields to activities.",
    {
      filter: z.string().optional(),
      select: z.string().optional(),
      orderby: z.string().optional(),
      top: z.number().optional(),
      skip: z.number().optional(),
    },
    async (args) => {
      try { return ok(await apiGet("/Issues", odata(args))); }
      catch (e) { return fail(e); }
    }
  );

  server.tool(
    "create_issue",
    "Create an issue in Aspire.",
    {
      subject: z.string().max(200),
      assignedTo: z.number().describe("ContactID"),
      notes: z.string().describe("Issue description (required)"),
      dueDate: z.string().optional(),
      priority: z.enum(["Low", "Medium", "High"]).optional(),
      opportunityId: z.number().optional(),
      propertyId: z.number().optional(),
      workTicketId: z.number().optional(),
      includeClient: z.boolean().optional(),
    },
    async (args) => {
      try {
        return ok(await apiPost("/Issues", {
          Subject: args.subject,
          AssignedTo: args.assignedTo,
          Notes: args.notes,
          DueDate: args.dueDate,
          Priority: args.priority,
          OpportunityID: args.opportunityId,
          PropertyID: args.propertyId,
          WorkTicketID: args.workTicketId,
          IncludeClient: args.includeClient,
        }));
      } catch (e) { return fail(e); }
    }
  );

  // ── LOOKUP / REFERENCE DATA ────────────────────────────────────────────────

  server.tool(
    "list_branches",
    "List branches. Key fields: BranchID, BranchName, BranchCode, Active, TimeZone.",
    { filter: z.string().optional(), top: z.number().optional() },
    async ({ filter, top }) => {
      try { return ok(await apiGet("/Branches", { "$filter": filter, "$top": top ?? 200 })); }
      catch (e) { return fail(e); }
    }
  );

  server.tool(
    "list_divisions",
    "List divisions. Key fields: DivisionID, DivisionName, DivisionCode, Active.",
    { filter: z.string().optional(), top: z.number().optional() },
    async ({ filter, top }) => {
      try { return ok(await apiGet("/Divisions", { "$filter": filter, "$top": top ?? 200 })); }
      catch (e) { return fail(e); }
    }
  );

  server.tool(
    "list_users",
    "List Aspire users. Key fields: UserID, ContactID, ContactName, Email.",
    { filter: z.string().optional(), top: z.number().optional() },
    async ({ filter, top }) => {
      try { return ok(await apiGet("/Users", { "$filter": filter, "$top": top ?? 200 })); }
      catch (e) { return fail(e); }
    }
  );

  server.tool(
    "list_service_types",
    "List service type lookup values. Key fields: ServiceTypeID, ServiceTypeName.",
    { top: z.number().optional() },
    async ({ top }) => {
      try { return ok(await apiGet("/ServiceTypes", { "$top": top ?? 500 })); }
      catch (e) { return fail(e); }
    }
  );

  server.tool(
    "list_services",
    "List services (the catalog of service offerings). Key fields: ServiceID, ServiceName.",
    { filter: z.string().optional(), top: z.number().optional() },
    async ({ filter, top }) => {
      try { return ok(await apiGet("/Services", { "$filter": filter, "$top": top ?? 500 })); }
      catch (e) { return fail(e); }
    }
  );

  server.tool(
    "list_catalog_items",
    "List catalog items (price list / materials). Key fields: CatalogItemID, CatalogItemName, UnitCost, UnitPrice.",
    { filter: z.string().optional(), top: z.number().optional(), skip: z.number().optional() },
    async ({ filter, top, skip }) => {
      try { return ok(await apiGet("/CatalogItems", { "$filter": filter, "$top": top ?? 100, "$skip": skip })); }
      catch (e) { return fail(e); }
    }
  );

  server.tool(
    "list_companies",
    "List companies (billing entities). Key fields: CompanyID, CompanyName.",
    { filter: z.string().optional(), top: z.number().optional() },
    async ({ filter, top }) => {
      try { return ok(await apiGet("/Companies", { "$filter": filter, "$top": top ?? 200 })); }
      catch (e) { return fail(e); }
    }
  );

  server.tool(
    "list_vendors",
    "List vendors. Key fields: VendorID, VendorName, Active.",
    { filter: z.string().optional(), top: z.number().optional() },
    async ({ filter, top }) => {
      try { return ok(await apiGet("/Vendors", { "$filter": filter, "$top": top ?? 200 })); }
      catch (e) { return fail(e); }
    }
  );

  server.tool(
    "list_equipment",
    "List equipment records. Key fields: EquipmentID, EquipmentName, Active, BranchID.",
    { filter: z.string().optional(), top: z.number().optional(), skip: z.number().optional() },
    async ({ filter, top, skip }) => {
      try { return ok(await apiGet("/Equipments", { "$filter": filter, "$top": top ?? 100, "$skip": skip })); }
      catch (e) { return fail(e); }
    }
  );

  server.tool(
    "get_api_version",
    "Get the Aspire API version and confirm connectivity (no auth required — use as a health check).",
    {},
    async () => {
      try {
        const r = await fetch(`${ASPIRE_BASE}/Version/GetApiVersion`);
        return ok(await r.json());
      } catch (e) { return fail(e); }
    }
  );

  return server;
}

// ─── EXPRESS APP ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Health check (for Render and monitoring)
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "aspire-mcp", timestamp: new Date().toISOString() });
});

// Session store for stateful MCP connections
const sessions = {};

// MCP endpoint — handles POST (new sessions and messages) + GET (SSE streaming) + DELETE
app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];

  try {
    let transport;

    if (sessionId && sessions[sessionId]) {
      // Existing session
      transport = sessions[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // New session initialization
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions[sid] = transport;
          console.log(`Session started: ${sid}`);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          delete sessions[transport.sessionId];
          console.log(`Session ended: ${transport.sessionId}`);
        }
      };
      const server = buildServer();
      await server.connect(transport);
    } else {
      res.status(400).json({ error: "Bad request: missing session or not an initialize request" });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("MCP request error:", e);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !sessions[sessionId]) {
    res.status(400).json({ error: "Invalid or missing session ID" });
    return;
  }
  try {
    await sessions[sessionId].handleRequest(req, res);
  } catch (e) {
    console.error("MCP GET error:", e);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && sessions[sessionId]) {
    try {
      await sessions[sessionId].close();
    } catch {}
    delete sessions[sessionId];
    console.log(`Session deleted: ${sessionId}`);
  }
  res.status(200).end();
});

// ─── SSE TRANSPORT (for mcp-remote / Claude Desktop compatibility) ───────────

const sseSessions = {};

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  sseSessions[transport.sessionId] = transport;
  transport.onclose = () => { delete sseSessions[transport.sessionId]; };
  const srv = buildServer();
  await srv.connect(transport);
  await transport.start();
  console.log(`SSE session started: ${transport.sessionId}`);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = sseSessions[sessionId];
  if (!transport) {
    res.status(400).json({ error: "Invalid or expired SSE session" });
    return;
  }
  await transport.handlePostMessage(req, res);
});

// Start server
app.listen(PORT, () => {
  console.log(`Aspire MCP server listening on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`SSE endpoint:  http://localhost:${PORT}/sse`);
  console.log(`MCP endpoint:  http://localhost:${PORT}/mcp`);
});
