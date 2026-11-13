// Route revenue and hours report.
//
// Does all the paging and math on the server and returns only finished totals,
// so a year of time entries never has to travel through a chat.
//
// Method (also returned in the "method" field of the result):
//  * Hours: every work ticket time entry dated in the period on the chosen routes.
//  * Budget hours: each ticket's estimated hours (HoursEst, which includes change
//    orders added as services), split across routes by each route's share of the
//    ticket's lifetime actual hours. A ticket worked only in the period by one
//    route gets its full estimate. A ticket started last year only brings the
//    share of its budget that matches the hours worked in the period.
//  * Invoiced revenue: pre-tax invoice line amounts dated in the period, voids
//    excluded. Each job's invoiced amount is split across ALL routes that logged
//    time on that job in the period, by hours. The chosen routes keep their share.
//    Jobs with invoices but no time in the period are listed as unallocated.

import { z } from "zod";

const PAGE = 500;
const CHUNK = 15; // Aspire rejects filters over 100 OData nodes
const PARALLEL = 3;
const MIN_GAP_MS = 250; // about 4 requests per second, well under Aspire's 20 per second account limit

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const dateOnly = (d) => (d ? String(d).slice(0, 10) : null);

// Paces every Aspire call and retries politely when Aspire answers 429.
function paced(apiGet) {
  let nextSlot = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  return async function (path, params) {
    for (let attempt = 0; ; attempt++) {
      const now = Date.now();
      const wait = Math.max(0, nextSlot - now);
      nextSlot = Math.max(now, nextSlot) + MIN_GAP_MS;
      if (wait) await sleep(wait);
      try {
        return await apiGet(path, params);
      } catch (e) {
        if (!/\b429\b/.test(String(e.message)) || attempt >= 6) throw e;
        await sleep(2000 * 2 ** attempt); // 2s, 4s, 8s, 16s, 32s, 64s
      }
    }
  };
}

async function getAll(apiGet, path, params) {
  const out = [];
  let skip = 0;
  for (let guard = 0; guard < 400; guard++) {
    const page = await apiGet(path, { ...params, $top: PAGE, $skip: skip || undefined });
    if (!Array.isArray(page) || page.length === 0) break;
    out.push(...page);
    skip += page.length;
  }
  return out;
}

async function inChunks(ids, fn) {
  const list = [...ids];
  const chunks = [];
  for (let i = 0; i < list.length; i += CHUNK) chunks.push(list.slice(i, i + CHUNK));
  const results = [];
  let next = 0;
  async function worker() {
    while (next < chunks.length) {
      const c = chunks[next++];
      results.push(...(await fn(c)));
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, chunks.length) }, worker));
  return results;
}

const orEq = (field, ids) => "(" + ids.map((id) => `${field} eq ${id}`).join(" or ") + ")";

const jobs = new Map();

export function registerReportTool(server, rawApiGet, fail) {
  let apiGet = rawApiGet;
  server.tool(
    "route_revenue_hours_report",
    `Year to date (or any period) report for a set of routes (trucks): invoiced revenue
    per route, and actual vs budgeted hours by route with a row per project (job).
    Pages through Aspire on the server and returns only totals plus a tie out section.
    Pass routeIds (e.g. Mayo's construction and enhancement trucks), startDate, endDate.`,
    {
      routeIds: z.array(z.number()).min(1).describe("RouteIDs to report on"),
      startDate: z.string().describe("YYYY-MM-DD, inclusive"),
      endDate: z.string().describe("YYYY-MM-DD, inclusive"),
      divisions: z
        .array(z.string())
        .optional()
        .describe("Divisions whose invoices form the tie out universe. Default Design Build and Enhancement"),
    },
    async (args) => {
      // Reports take a few minutes, longer than a client will wait. The first call
      // starts a background job; calling again with the same inputs returns its
      // progress, then the finished result (kept for 30 minutes).
      const key = JSON.stringify([args.routeIds, args.startDate, args.endDate, args.divisions || null]);
      const now = Date.now();
      for (const [k, j] of jobs) if (now - j.startedAt > 30 * 60 * 1000) jobs.delete(k);
      let job = jobs.get(key);
      if (!job || job.status === "error") {
        job = { status: "running", startedAt: now, progress: "starting" };
        job.promise = compute(args, job)
          .then((text) => { job.status = "done"; job.text = text; })
          .catch((e) => { job.status = "error"; job.error = e.message; console.error("Report error:", e.message); });
        jobs.set(key, job);
      }
      await Promise.race([job.promise, new Promise((r) => setTimeout(r, 45000))]);
      if (job.status === "done") return { content: [{ type: "text", text: job.text }] };
      if (job.status === "error") return fail(new Error(job.error));
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "running",
            progress: job.progress,
            runningSeconds: Math.round((Date.now() - job.startedAt) / 1000),
            next: "Call this tool again with exactly the same inputs in about a minute to get the result.",
          }),
        }],
      };
    },
  );

  async function compute({ routeIds, startDate, endDate, divisions }, job) {
      {
        apiGet = paced(rawApiGet);
        const started = Date.now();
        const divs = new Set(divisions && divisions.length ? divisions : ["Design Build", "Enhancement"]);
        const chosen = new Set(routeIds);
        const dateFilter = `WorkTicketTimeDate ge ${startDate} and WorkTicketTimeDate le ${endDate}`;

        // 1. Routes, for names.
        const routes = await getAll(apiGet, "/Routes", {
          $select: "RouteID,RouteName,DivisionName,CrewLeaderContactName,ManagerName,Active",
        });
        const routeById = new Map(routes.map((r) => [r.RouteID, r]));

        job.progress = "time entries on chosen routes";
        // 2. Time entries on the chosen routes in the period.
        const chosenTimes = await getAll(apiGet, "/WorkTicketTimes", {
          $filter: `${dateFilter} and ${orEq("RouteID", routeIds)}`,
          $select: "WorkTicketTimeID,WorkTicketID,RouteID,Hours,WarrantyTime",
        });
        const chosenTicketIds = new Set(chosenTimes.map((t) => t.WorkTicketID));

        job.progress = "tickets";
        // 3. Those tickets, to learn their jobs.
        const ticketSelect =
          "WorkTicketID,WorkTicketNumber,OpportunityID,OpportunityNumber,HoursEst,HoursAct,WorkTicketStatusName";
        const firstTickets = await inChunks(chosenTicketIds, (ids) =>
          apiGet("/WorkTickets", { $filter: orEq("WorkTicketID", ids), $select: ticketSelect, $top: PAGE }),
        );
        const oppIds = new Set(firstTickets.map((t) => t.OpportunityID).filter(Boolean));

        job.progress = "all tickets and time on those jobs";
        // 4. Every ticket on those jobs, and every route's time on them in the period.
        const allTickets = await inChunks(oppIds, (ids) =>
          getAll(apiGet, "/WorkTickets", { $filter: orEq("OpportunityID", ids), $select: ticketSelect }),
        );
        const ticketById = new Map();
        for (const t of [...firstTickets, ...allTickets]) ticketById.set(t.WorkTicketID, t);

        const allTimes = await inChunks(ticketById.keys(), (ids) =>
          getAll(apiGet, "/WorkTicketTimes", {
            $filter: `${dateFilter} and ${orEq("WorkTicketID", ids)}`,
            $select: "WorkTicketTimeID,WorkTicketID,RouteID,Hours",
          }),
        );
        // Make sure the chosen routes' entries are all present exactly once.
        const timeById = new Map();
        for (const t of [...allTimes, ...chosenTimes]) timeById.set(t.WorkTicketTimeID, t);

        job.progress = "job details";
        // 5. Job details.
        const opps = await inChunks(oppIds, (ids) =>
          apiGet("/Opportunities", {
            $filter: orEq("OpportunityID", ids),
            $select:
              "OpportunityID,OpportunityNumber,OpportunityName,PropertyName,DivisionName,OpportunityStatusName,WonDollars,OperationsManagerContactName",
            $top: PAGE,
          }),
        );
        const oppById = new Map(opps.map((o) => [o.OpportunityID, o]));

        job.progress = "invoices";
        // 6. Invoices in the period.
        const invoices = await getAll(apiGet, "/Invoices", {
          $filter: `InvoiceDate ge ${startDate} and InvoiceDate le ${endDate}`,
          $expand: "InvoiceOpportunities($filter=OpportunityID gt 0)",
        });

        job.progress = "calculating";
        // ── Math ────────────────────────────────────────────────────────────
        // Hours per ticket per route (period), and per job per route.
        const tktRoute = new Map(); // ticketId -> Map(routeId -> hours)
        const oppRoute = new Map(); // oppId -> Map(routeId -> hours)
        let warrantyHours = 0;
        let noTicketHours = 0;
        for (const t of timeById.values()) {
          const h = Number(t.Hours) || 0;
          if (!tktRoute.has(t.WorkTicketID)) tktRoute.set(t.WorkTicketID, new Map());
          const m = tktRoute.get(t.WorkTicketID);
          m.set(t.RouteID, (m.get(t.RouteID) || 0) + h);
          const tk = ticketById.get(t.WorkTicketID);
          if (!tk || !tk.OpportunityID) {
            if (chosen.has(t.RouteID)) noTicketHours += h;
            continue;
          }
          if (!oppRoute.has(tk.OpportunityID)) oppRoute.set(tk.OpportunityID, new Map());
          const om = oppRoute.get(tk.OpportunityID);
          om.set(t.RouteID, (om.get(t.RouteID) || 0) + h);
        }
        for (const t of chosenTimes) if (t.WarrantyTime) warrantyHours += Number(t.Hours) || 0;

        // Invoiced pre-tax amount per job in the period.
        const invByOpp = new Map();
        let voidCount = 0;
        let invoiceLines = 0;
        for (const inv of invoices) {
          if (inv.InvoiceVoid === "Y") { voidCount++; continue; }
          for (const line of inv.InvoiceOpportunities || []) {
            const inUniverse = divs.has(line.DivisionName) || oppIds.has(line.OpportunityID);
            if (!inUniverse) continue;
            invoiceLines++;
            const cur = invByOpp.get(line.OpportunityID) || { amount: 0, division: line.DivisionName, number: line.OpportunityNumber, name: line.OpportunityName, invoices: 0 };
            cur.amount += Number(line.Amount) || 0;
            cur.invoices++;
            invByOpp.set(line.OpportunityID, cur);
          }
        }

        // Allocate each job's invoiced amount across routes by period hours.
        const allocByRouteOpp = new Map(); // `${route}|${opp}` -> $
        let allocChosen = 0, allocOther = 0, unallocated = 0;
        const unallocatedJobs = [];
        for (const [oppId, inv] of invByOpp) {
          const hrs = oppRoute.get(oppId);
          const total = hrs ? [...hrs.values()].reduce((a, b) => a + b, 0) : 0;
          if (!total) {
            unallocated += inv.amount;
            unallocatedJobs.push([inv.number, inv.name, inv.division, round2(inv.amount)]);
            continue;
          }
          for (const [routeId, h] of hrs) {
            const share = (inv.amount * h) / total;
            if (chosen.has(routeId)) {
              allocChosen += share;
              const k = `${routeId}|${oppId}`;
              allocByRouteOpp.set(k, (allocByRouteOpp.get(k) || 0) + share);
            } else allocOther += share;
          }
        }

        // Rows: route x job.
        const rows = new Map(); // `${route}|${opp}` -> row
        let unbudgetedHours = 0;
        for (const [ticketId, m] of tktRoute) {
          const tk = ticketById.get(ticketId);
          if (!tk || !tk.OpportunityID) continue;
          const est = Number(tk.HoursEst) || 0;
          const periodAll = [...m.values()].reduce((a, b) => a + b, 0);
          const lifetime = Math.max(Number(tk.HoursAct) || 0, periodAll);
          for (const [routeId, h] of m) {
            if (!chosen.has(routeId)) continue;
            const k = `${routeId}|${tk.OpportunityID}`;
            const r = rows.get(k) || { routeId, oppId: tk.OpportunityID, hours: 0, budget: 0, tickets: new Set(), open: 0 };
            r.hours += h;
            r.budget += lifetime ? (est * h) / lifetime : 0;
            r.tickets.add(ticketId);
            if (tk.WorkTicketStatusName && tk.WorkTicketStatusName !== "Complete") r.open++;
            if (!est) unbudgetedHours += h;
            rows.set(k, r);
          }
        }

        const projectRows = [...rows.values()]
          .map((r) => {
            const o = oppById.get(r.oppId) || {};
            const routesOnJob = oppRoute.get(r.oppId);
            const shared = routesOnJob ? [...routesOnJob.keys()].filter((x) => x !== r.routeId).length : 0;
            return [
              r.routeId,
              o.OpportunityNumber ?? null,
              o.OpportunityName ?? null,
              o.PropertyName ?? null,
              o.DivisionName ?? null,
              o.OpportunityStatusName ?? null,
              r.tickets.size,
              r.open > 0 ? "has open tickets" : "all complete",
              shared,
              round2(r.hours),
              round2(r.budget),
              round2(allocByRouteOpp.get(`${r.routeId}|${r.oppId}`) || 0),
            ];
          })
          .sort((a, b) => a[0] - b[0] || b[9] - a[9]);

        const routeSummary = routeIds.map((id) => {
          const rt = routeById.get(id) || {};
          const mine = projectRows.filter((p) => p[0] === id);
          const hrs = chosenTimes.filter((t) => t.RouteID === id).reduce((a, t) => a + (Number(t.Hours) || 0), 0);
          return {
            routeId: id,
            routeName: rt.RouteName ?? null,
            division: rt.DivisionName ?? null,
            crewLeader: rt.CrewLeaderContactName ?? null,
            manager: rt.ManagerName ?? null,
            active: rt.Active ?? null,
            timeEntries: chosenTimes.filter((t) => t.RouteID === id).length,
            hours: round2(hrs),
            budgetHours: round2(mine.reduce((a, p) => a + p[10], 0)),
            invoicedAllocated: round2(mine.reduce((a, p) => a + p[11], 0)),
            projects: mine.length,
          };
        });

        const chosenHours = chosenTimes.reduce((a, t) => a + (Number(t.Hours) || 0), 0);
        const universe = [...invByOpp.values()].reduce((a, v) => a + v.amount, 0);

        const result = {
          period: { startDate, endDate },
          method: [
            "Hours are all time entries dated in the period on each route.",
            "Budget hours are each ticket's HoursEst split by the route's share of the ticket's lifetime actual hours.",
            "Invoiced revenue is pre-tax invoice line Amount dated in the period, voids excluded, split across all routes that logged time on the job in the period, by hours.",
          ],
          routes: routeSummary,
          projectColumns: [
            "routeId", "jobNumber", "jobName", "property", "division", "jobStatus", "tickets",
            "ticketStatus", "otherRoutesOnJob", "actualHours", "budgetHours", "invoicedAllocated",
          ],
          projects: projectRows,
          tieOut: {
            chosenRouteTimeEntries: chosenTimes.length,
            chosenRouteHours: round2(chosenHours),
            hoursInProjectRows: round2(projectRows.reduce((a, p) => a + p[9], 0)),
            hoursWithNoJob: round2(noTicketHours),
            warrantyHours: round2(warrantyHours),
            hoursOnTicketsWithNoEstimate: round2(unbudgetedHours),
            invoicesInPeriod: invoices.length,
            voidInvoicesExcluded: voidCount,
            invoiceLinesInUniverse: invoiceLines,
            invoicedUniverseTotal: round2(universe),
            allocatedToChosenRoutes: round2(allocChosen),
            allocatedToOtherRoutes: round2(allocOther),
            unallocatedNoHoursInPeriod: round2(unallocated),
            check_universe_minus_parts: round2(universe - allocChosen - allocOther - unallocated),
            unallocatedJobsColumns: ["jobNumber", "jobName", "division", "amount"],
            unallocatedJobs: unallocatedJobs.sort((a, b) => b[3] - a[3]),
          },
          runSeconds: Math.round((Date.now() - started) / 1000),
        };
        return JSON.stringify(result);
      }
  }
}
