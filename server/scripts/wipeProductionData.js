/**
 * One-time maintenance script: permanently deletes every Job, Worker,
 * Notification, FormRollout, and User document - i.e. wipes the app back
 * to a completely empty slate, ready for the client's real production use
 * (no more test/demo jobs, workers, or logins left over from development).
 *
 * DELIBERATELY LEFT ALONE: GeocodeCache (just a lat/lng lookup cache, not
 * "data" in any meaningful sense - safe either way, so there's no reason
 * to touch it).
 *
 * Users are wiped too. Rather than leaning on
 * server/src/services/auth.js's ensureDefaultAdmin() (which only ever
 * creates ONE account automatically, whenever the User collection is
 * empty - fine for a single admin, but it would leave whoever ISN'T that
 * one account locked out with no way back in except asking the other
 * person to add them via Settings), this script creates BOTH admin
 * logins itself, directly, right after wiping - no dependency on anyone
 * logging in first:
 *
 *   ADMIN_EMAIL / ADMIN_PASSWORD          - the primary account (e.g. WyeLee)
 *   EXTRA_ADMIN_EMAIL / EXTRA_ADMIN_PASSWORD - a second account (e.g. you)
 *
 * Set whichever of these pairs you want in your environment before
 * running with the confirm flag. Leaving EXTRA_ADMIN_EMAIL unset just
 * creates the one account, same as before. Leaving BOTH unset creates no
 * accounts at all, and ensureDefaultAdmin() will fall back to its own
 * default (admin@example.com / a random generated password) on the
 * server's next startup, same as it always has.
 *
 * THIS IS IRREVERSIBLE. There is no undo, no trash, no soft-delete - once
 * this runs, that data is gone. Take a database backup/export first if
 * there's ANY chance you'll want any of it back later (Render's MongoDB
 * add-on, and MongoDB Atlas both offer one-click backups/snapshots from
 * their own dashboards - do that first if you're at all unsure).
 *
 * Usage (from inside the `server` folder), against whichever database
 * MONGO_URI in your environment currently points to:
 *
 *   node scripts/wipeProductionData.js --yes-really-wipe-everything
 *
 * Running it WITHOUT that exact flag does nothing but print what it would
 * have deleted - a dry run, safe to run any time just to sanity-check
 * which database you're currently pointed at before you commit to it.
 *
 * If you want to run this against Render's live production database
 * specifically, the safest place to run it is Render's own "Shell" tab
 * for this service - it already has the real production MONGO_URI (and
 * ADMIN_EMAIL/ADMIN_PASSWORD, if you've set them there) loaded as
 * environment variables, so you don't need to copy that connection string
 * anywhere else by hand.
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/db.js";
import Job from "../src/models/Job.js";
import Worker from "../src/models/Worker.js";
import Notification from "../src/models/Notification.js";
import FormRollout from "../src/models/FormRollout.js";
import User from "../src/models/User.js";
import { hashPassword } from "../src/services/auth.js";

const CONFIRM_FLAG = "--yes-really-wipe-everything";
const confirmed = process.argv.includes(CONFIRM_FLAG);

function maskUri(uri) {
  return uri.replace(/\/\/([^@/]+)@/, "//***@");
}

async function main() {
  const uri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/worker_assignment";
  console.log(`\nTarget database: ${maskUri(uri)}\n`);

  await connectDB();

  const [jobCount, workerCount, notificationCount, rolloutCount, userCount] = await Promise.all([
    Job.countDocuments(),
    Worker.countDocuments(),
    Notification.countDocuments(),
    FormRollout.countDocuments(),
    User.countDocuments(),
  ]);

  console.log("Currently in this database:");
  console.log(`  Jobs:          ${jobCount}`);
  console.log(`  Workers:       ${workerCount}`);
  console.log(`  Notifications: ${notificationCount}`);
  console.log(`  Form rollouts: ${rolloutCount}`);
  console.log(`  User logins:   ${userCount}`);

  if (!confirmed) {
    console.log(
      `\nDry run only - nothing was deleted. Re-run with ${CONFIRM_FLAG} to actually wipe all of the above.\n`
    );
    process.exit(0);
  }

  console.log("\n--yes-really-wipe-everything given - deleting everything listed above now...\n");

  const results = await Promise.all([
    Job.deleteMany({}),
    Worker.deleteMany({}),
    Notification.deleteMany({}),
    FormRollout.deleteMany({}),
    User.deleteMany({}),
  ]);

  console.log("Done:");
  console.log(`  Jobs deleted:          ${results[0].deletedCount}`);
  console.log(`  Workers deleted:       ${results[1].deletedCount}`);
  console.log(`  Notifications deleted: ${results[2].deletedCount}`);
  console.log(`  Form rollouts deleted: ${results[3].deletedCount}`);
  console.log(`  User logins deleted:   ${results[4].deletedCount}`);

  // Recreate whichever admin login(s) were configured - see the file
  // header comment for why this is done directly here rather than left
  // to ensureDefaultAdmin() (which only ever makes ONE account, chosen
  // arbitrarily by whichever env vars happen to be set at server startup
  // time - not good enough when TWO specific people each need their own
  // login back immediately, with neither depending on the other).
  const accountsToCreate = [
    {
      label: "primary (ADMIN_EMAIL)",
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD,
      // ADMIN_NAME/EXTRA_ADMIN_NAME are optional - set them if you want
      // something nicer than "Admin" showing up twice in Settings > Users.
      name: process.env.ADMIN_NAME || "Admin",
    },
    {
      label: "extra (EXTRA_ADMIN_EMAIL)",
      email: process.env.EXTRA_ADMIN_EMAIL,
      password: process.env.EXTRA_ADMIN_PASSWORD,
      name: process.env.EXTRA_ADMIN_NAME || "Admin",
      // Kept out of the client-facing Settings > Users list (see the
      // User model's `hidden` field) - this account still logs in
      // completely normally, it just never shows up there for whoever
      // else is logged in (e.g. WyeLee) to see.
      hidden: true,
    },
  ].filter((a) => a.email && a.password);

  if (accountsToCreate.length === 0) {
    console.log(
      "\nNo ADMIN_EMAIL/ADMIN_PASSWORD or EXTRA_ADMIN_EMAIL/EXTRA_ADMIN_PASSWORD set - " +
        "created no admin logins here. ensureDefaultAdmin() will create its own default " +
        "(admin@example.com / a random generated password, printed in the server logs) " +
        "the next time the server starts, since it'll see zero User accounts.\n"
    );
  } else {
    for (const account of accountsToCreate) {
      await User.create({
        name: account.name,
        email: account.email.toLowerCase().trim(),
        passwordHash: hashPassword(account.password),
        hidden: Boolean(account.hidden),
      });
      console.log(`  Created admin login (${account.label}): ${account.email}`);
    }
    console.log(
      "\nThose account(s) are ready to log in with right now - no server restart needed " +
        "for this part (though a restart/redeploy is still worth doing to make sure " +
        "everything else picks up any other env var changes you made).\n"
    );
  }
}

main()
  .catch((err) => {
    console.error("\nFailed:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close();
  });
