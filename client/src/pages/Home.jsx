import { useState } from "react";
import { useNavigate } from "react-router-dom";
import JobDraftForm from "../components/JobDraftForm.jsx";
import { scrapeJobLink, createJob } from "../api.js";

// Home is deliberately just the "bring in a job" step now - the jobs list
// itself (with filtering/charts/export) lives on its own page, see
// pages/Jobs.jsx.
export default function Home() {
  const navigate = useNavigate();
  const [url, setUrl] = useState("");
  const [authHeader, setAuthHeader] = useState("");
  const [showAuthHeader, setShowAuthHeader] = useState(false);
  const [scraping, setScraping] = useState(false);
  const [scrapeError, setScrapeError] = useState("");
  const [draft, setDraft] = useState(null);
  const [saved, setSaved] = useState(false);

  async function handleScrape(e) {
    e.preventDefault();
    setScrapeError("");
    setSaved(false);
    if (!url.trim()) {
      setScrapeError("Paste a job link first.");
      return;
    }
    setScraping(true);
    try {
      const result = await scrapeJobLink(url.trim(), authHeader.trim() || undefined);
      setDraft(result);
    } catch (err) {
      setScrapeError(err.message);
    } finally {
      setScraping(false);
    }
  }

  async function handleSaveDraft(form) {
    await createJob(form);
    setDraft(null);
    setUrl("");
    setAuthHeader("");
    setSaved(true);
    navigate("/jobs");
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Bring in a job</h1>
          <p className="muted small">Paste a job posting link below - the details are fetched and pre-filled automatically.</p>
        </div>
      </div>

      <div className="card scrape-card">
        <form onSubmit={handleScrape} className="scrape-form">
          <label>
            Job posting link
            <input
              type="url"
              placeholder="https://example.com/jobs/123?token=..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
            />
          </label>
          <p className="muted small">
            If the link includes an access token as part of the URL, it's fetched exactly as
            pasted - no extra setup needed.{" "}
            <button
              type="button"
              className="link-button"
              onClick={() => setShowAuthHeader((s) => !s)}
            >
              {showAuthHeader ? "Hide" : "The site needs an Authorization header instead?"}
            </button>
          </p>
          {showAuthHeader && (
            <label>
              Authorization header value (optional)
              <input
                placeholder="Bearer eyJhbGciOi..."
                value={authHeader}
                onChange={(e) => setAuthHeader(e.target.value)}
              />
            </label>
          )}
          {scrapeError && <div className="form-error">{scrapeError}</div>}
          <div className="form-actions">
            <button className="btn btn-primary" type="submit" disabled={scraping}>
              {scraping ? "Fetching..." : "Fetch job details"}
            </button>
          </div>
        </form>
      </div>

      {saved && <div className="banner banner-success">Job saved - taking you to the Jobs tab...</div>}

      {draft && (
        <JobDraftForm draft={draft} onSave={handleSaveDraft} onDiscard={() => setDraft(null)} />
      )}
    </div>
  );
}
