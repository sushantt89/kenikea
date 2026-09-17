/**
 * Seeds the database with mock workers and a mock job, then runs the real
 * assignment engine (and, if configured, the real Google Calendar
 * integration) against them - so you can see the whole pipeline work
 * end-to-end without needing a live job link or a fully staffed roster.
 *
 * The mock job is built from a stand-in copy of the real InstallEzi/
 * Beehiive job payload shape (an IKEA assembly job), run through the
 * actual scraper code (`scrapeJob`) with `fetch` temporarily stubbed out -
 * so this also doubles as a smoke test for the scraper's field extraction.
 *
 *   npm run seed
 *
 * This WIPES existing workers and jobs first, so only run it against a
 * throwaway/dev database.
 *
 * COORDINATES ARE MOCKED, NOT GEOCODED. This script's whole job is to test
 * the assignment engine and the Calendar integration deterministically and
 * instantly - it deliberately does NOT call the real geocoding service
 * (Nominatim/LocationIQ). The lat/lng below are the real, correct
 * coordinates for these Adelaide addresses (looked up once, by hand), typed
 * in directly - exactly like a worker's own coordinates would look once
 * they've already been geocoded and saved. Real geocoding-on-save is
 * already exercised by the actual API routes (POST/PUT /api/workers,
 * POST/PUT /api/jobs) - see server/src/services/geocode.js - there's no
 * need for this script to also hit that external API every time it runs.
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "./db.js";
import Worker from "./models/Worker.js";
import Job from "./models/Job.js";
import { scrapeJob } from "./services/scraper.js";
import { rankCandidates } from "./services/assignment.js";
import { createAssignmentEvent } from "./services/googleCalendar.js";
import { isConfigured as calendarConfigured } from "./services/googleCalendar.js";

const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS || 2);

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function ordinal(n) {
  const suffixes = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]}`;
}

/**
 * Builds a stand-in copy of the real job-source payload, with the
 * "Expected date" text pointing at `scheduledDate` so the mock job always
 * lands in the future no matter when you run this script.
 */
function buildMockBeehiivePayload(scheduledDate) {
  const expectedDateText = `Expected date 7:00am to 5:00pm ${DOW[scheduledDate.getDay()]} ${ordinal(
    scheduledDate.getDate()
  )} ${MONTHS[scheduledDate.getMonth()]} ${scheduledDate.getFullYear()} (ACST)`;

  return {
    success: true,
    job: {
      jobId: "688928",
      title: "",
      serviceGroup: null,
      orderNumber: "Created Aug 20, 2026 232755318 Billing Deviation Case #",
      scheduled: { start: null, display: null },
      expectedSchedule: "JOB INSTRUCTIONS IKEA is an assembly service undertaken on a fixed fee basis with all work being on-site.",
      location: { address: "4b Norman Street Woodville SA 5011" },
      customer: { name: "Nadia Negruk", phone: "0424 630 744", email: "feedback@beehiive.com" },
      serviceCentre: { name: "Accept this job", distance: "6.34 km / 11 mins to job site" },
      products: [
        "2 x 20616549 - BESTÅ TV bnch 120x40x38 white AU",
        "4 x 70352683 (SecureIT!) - BESTÅ shelf 56x36 white AP",
        "2 x 30496363 (SecureIT!) - BESTÅ TV top pnl f TV 120x42 oak veneer AP",
        "2 x 10488316 (SecureIT!) - BESTÅ NN drwr runnr p-open 2-p AP",
        "2 x 70617650 - BESTÅ N drwr frm 60x15x40 white AU",
        "2 x 40291634 - SELSVIKEN drawer frt 60x26 hg white AP CN",
        "2 x 60261259 (SecureIT!) - BESTÅ soft clsng/push-open hinge 2-p AP CN",
        "2 x 00291631 - SELSVIKEN door/drawer fr 60x38 hg white AP CN",
      ],
      description: [
        `Assembly ${expectedDateText} 2 x 20616549 - BESTÅ TV bnch 120x40x38 white AU 106 mins (1.77 hrs) allocated Instructions Attachments / IHP Links NO`,
        "Secure it! Product/s in this Job Sheet require IKEA Secure it!",
        "Attend, set up and commence IKEA assembly",
      ],
      notes: [],
      charges: [
        { description: "SA / WA Call out fee", quantity: "1.00", unit: "36.05", price: "36.05 AUD ex" },
        { description: "SA Cabinetry (33495325)", quantity: "1.77", unit: "43.81", price: "77.54 AUD ex" },
      ],
      sourceUrl: "https://jobs.beehiive.com/jobs/688928",
    },
  };
}

async function scrapeMockJob() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const payload = buildMockBeehiivePayload(tomorrow);
  const mockUrl = "https://jobs.beehiive.com/jobs/688928?token=demo-token-123";

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: (k) => (k.toLowerCase() === "content-type" ? "application/json" : null) },
    text: async () => JSON.stringify(payload),
  });

  try {
    return await scrapeJob(mockUrl);
  } finally {
    global.fetch = originalFetch;
  }
}

async function seed() {
  await connectDB();

  console.log("[seed] clearing existing workers and jobs (this script is for a throwaway/dev database)...");
  await Worker.deleteMany({});
  await Job.deleteMany({});

  // A deliberately varied roster so the ranking demonstrates all four
  // assignment rules at once:
  //   - Ray is unavailable -> excluded outright (rule 1)
  //   - Tom is local but underqualified -> heavily penalised (rule 2)
  //   - Priya vs Jess have identical skill, but Priya is closer to the job
  //     than Jess -> location breaks the tie (rule 3)
  //   - Sam is well-qualified, but already has an active job at the same
  //     address as this one -> a small "already busy" penalty (rule 4)
  //
  // lat/lng are the real coordinates for these addresses, typed in
  // directly (mocked) rather than geocoded - see the file header comment.
  const workerDefs = [
    {
      name: "Priya Nair",
      email: "priya.nair@example.com",
      location: "5 Quandong Street, North Brighton SA",
      lat: -35.006564,
      lng: 138.519973,
      gender: "Female",
      phone: "+61 400 111 222",
      availability: true,
      skillLevel: 5,
      priority: "Medium",
    },
    {
      name: "Tom Baxter",
      email: "tom.baxter@example.com",
      location: "82 Quinlan Avenue, Pasadena SA",
      lat: -35.002,
      lng: 138.59,
      gender: "Male",
      phone: "+61 400 333 444",
      availability: true,
      skillLevel: 2,
      priority: "High",
    },
    {
      name: "Sam Lee",
      email: "sam.lee@example.com",
      location: "301 Greenhill Road, Toorak Gardens SA",
      lat: -34.933,
      lng: 138.638,
      gender: "Other",
      phone: "+61 400 555 666",
      availability: true,
      skillLevel: 4,
      priority: "Medium",
    },
    {
      name: "Jess Whitfield",
      email: "jess.whitfield@example.com",
      location: "Daws Road, Edwardstown SA",
      lat: -34.98,
      lng: 138.571,
      gender: "Female",
      phone: "+61 400 777 888",
      availability: true,
      skillLevel: 5,
      priority: "Medium",
    },
    {
      name: "Ray Thompson",
      email: "ray.thompson@example.com",
      location: "Adelaide CBD SA",
      lat: -34.9285,
      lng: 138.6007,
      gender: "Male",
      phone: "+61 400 999 000",
      availability: false, // on leave - should be excluded outright
      skillLevel: 4,
      priority: "Low",
    },
  ];

  console.log("[seed] worker roster (coordinates are mocked, not geocoded - see file header):");
  console.table(workerDefs.map((w) => ({ name: w.name, location: w.location, lat: w.lat, lng: w.lng })));

  const workers = await Worker.insertMany(workerDefs);
  const sam = workers.find((w) => w.name === "Sam Lee");

  // Same address (and same mocked coordinates) as Sam Lee, on purpose - this
  // is what lets rule 4 (already has an active job "in the same area")
  // actually trigger below, rather than hoping two different addresses
  // happen to geocode close together.
  const fenceJob = {
    title: "Repair fence panel",
    description: "Mock pre-existing job so Sam Lee shows up as already partially booked in this test run.",
    sourceUrl: "https://example.com/mock-job/0",
    location: sam.location,
    lat: sam.lat,
    lng: sam.lng,
    difficulty: "Medium",
    priority: "Low",
  };
  await Job.create({
    ...fenceJob,
    status: "Assigned",
    assignedWorkers: [{ worker: sam._id, payout: null }],
    assignedAt: new Date(),
  });

  console.log("[seed] scraping a mock version of the real job payload format (fetch is stubbed, nothing goes out over the network)...");
  const draft = await scrapeMockJob();
  console.log(
    `[seed] scraper produced: "${draft.title}" · difficulty ${draft.difficulty} · address "${draft.location}"`
  );

  // Real coordinates for "4b Norman Street Woodville SA 5011", mocked in
  // directly rather than geocoded - same reasoning as the workers above.
  draft.lat = -34.879314;
  draft.lng = 138.537712;

  const mockJob = await Job.create(draft);

  console.log(`\n[seed] created ${workers.length} mock workers, 1 pre-existing job, and this new job:`);
  console.log(
    `       "${mockJob.title}" - ${mockJob.location} (${mockJob.lat}, ${mockJob.lng}), difficulty ${mockJob.difficulty}\n`
  );

  const activeJobs = await Job.find({ status: "Assigned" }).lean();
  const result = rankCandidates(mockJob, workers, activeJobs, MAX_CONCURRENT_JOBS);

  console.log("[seed] ranked candidates:");
  console.table(
    result.ranking.map((r) => ({
      worker: r.name,
      total: r.total,
      skill: r.breakdown.skill.score,
      location: r.breakdown.location.score,
      // "coordinates" = real distance (haversine) was used; "text" = no
      // coordinates on one/both sides, fell back to comparing address text.
      distanceKm: r.breakdown.location.distanceKm ?? "-",
      locationMethod: r.breakdown.location.method,
      load: r.breakdown.load.score,
      priorityBonus: r.breakdown.priorityBonus,
    }))
  );
  if (result.excluded.length) {
    console.log("[seed] excluded:", result.excluded.map((e) => `${e.name} (${e.reason})`).join(", "));
  }

  const winner = result.assigned;
  if (!winner) {
    console.log("[seed] no eligible worker was found - nothing to assign.");
    await mongoose.disconnect();
    return;
  }

  const winnerDoc = workers.find((w) => String(w._id) === String(winner.workerId));

  // A demo payout, just so this seed script's calendar invite actually goes
  // out - see services/googleCalendar.js: NO invite is ever sent until
  // every assigned worker has a payout entered, so leaving this null (as a
  // real brand-new assignment would start out) would make the demo below
  // always report "not created" instead of showing a real event.
  const demoPayout = 50;
  mockJob.assignedWorkers = [{ worker: winnerDoc._id, payout: demoPayout }];
  mockJob.status = "Assigned";
  mockJob.assignedAt = new Date();

  console.log(`\n[seed] assigning "${mockJob.title}" to ${winnerDoc.name} (score ${winner.total})...`);

  if (!calendarConfigured()) {
    console.log(
      "[seed] Google Calendar is not configured (GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN not set) - skipping the calendar invite. See README > Google Calendar setup."
    );
  } else {
    const calendarResult = await createAssignmentEvent(mockJob, [winnerDoc], {
      payoutView: { mode: "shared", amount: demoPayout },
    });
    if (calendarResult.created) {
      mockJob.googleCalendar = { events: [{ eventId: calendarResult.eventId, htmlLink: calendarResult.htmlLink, workerId: null }] };
      console.log(`[seed] Google Calendar event created: ${calendarResult.htmlLink}`);
    } else {
      console.log(`[seed] Google Calendar event NOT created: ${calendarResult.reason}`);
    }
  }

  await mockJob.save();

  console.log(
    "\n[seed] done. Run `npm run dev` here and `npm run dev` in client/, then open the app to see this data in the UI."
  );
  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error("[seed] failed:", err);
  process.exit(1);
});
