import { useEffect, useMemo, useState } from "react";

const API_BASE = import.meta.env.VITE_API_BASE || "http://127.0.0.1:3003";

const shotSet = [
  {
    kind: "phone tall-left",
    src: "/media/iphone-off-desk.png",
    alt: "Clawdex phone screenshot showing the main thread view",
  },
  {
    kind: "phone tall-center",
    src: "/media/iphone-live-activity.png",
    alt: "Clawdex phone screenshot showing live activity",
  },
  {
    kind: "phone tall-right",
    src: "/media/iphone-review-diffs.png",
    alt: "Clawdex phone screenshot showing diff review",
  },
];

const railShots = [
  {
    title: "Thread control",
    copy: "Jump between active coding sessions without losing the machine-side state.",
    src: "/media/ipad-manage-threads.png",
    alt: "Clawdex iPad screenshot with multiple thread views",
  },
  {
    title: "Git review",
    copy: "Inspect code changes and commit-ready diffs before anything lands.",
    src: "/media/ipad-review-diffs.png",
    alt: "Clawdex iPad screenshot with git diff review",
  },
];

function App() {
  const [data, setData] = useState(null);
  const [pulse, setPulse] = useState(null);
  const [form, setForm] = useState({ email: "", interest: "Preview websites from mobile" });
  const [submitState, setSubmitState] = useState({ type: "idle", message: "" });

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/landing`)
      .then((response) => {
        if (!response.ok) {
          throw new Error("Failed to load landing content");
        }
        return response.json();
      })
      .then((payload) => {
        if (cancelled) {
          return;
        }
        setData(payload);
        setPulse(payload.pulse);
      })
      .catch((error) => {
        if (!cancelled) {
          setSubmitState({ type: "error", message: error.message });
        }
      });

    const eventSource = new EventSource(`${API_BASE}/api/pulse`);
    eventSource.addEventListener("pulse", (event) => {
      try {
        const payload = JSON.parse(event.data);
        setPulse(payload);
      } catch {
        // Ignore malformed demo payloads.
      }
    });
    eventSource.onerror = () => {
      eventSource.close();
    };

    return () => {
      cancelled = true;
      eventSource.close();
    };
  }, []);

  const proof = data?.proof || [];
  const workflow = data?.workflow || [];
  const stats = data?.stats || [];
  const waitlistCount = pulse?.waitlistCount ?? 0;
  const waitlistLabel = useMemo(() => {
    if (waitlistCount === 0) {
      return "No demo signups yet";
    }
    if (waitlistCount === 1) {
      return "1 demo signup";
    }
    return `${waitlistCount} demo signups`;
  }, [waitlistCount]);

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitState({ type: "loading", message: "Saving your spot..." });
    try {
      const response = await fetch(`${API_BASE}/api/waitlist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "Could not save your signup.");
      }
      setSubmitState({ type: "success", message: payload.message });
      setForm((current) => ({ ...current, email: "" }));
      setPulse((current) =>
        current
          ? {
              ...current,
              waitlistCount: payload.count,
            }
          : current
      );
    } catch (error) {
      setSubmitState({
        type: "error",
        message: error instanceof Error ? error.message : "Could not save your signup.",
      });
    }
  }

  return (
    <div className="page-shell">
      <header className="hero">
        <nav className="brand-row">
          <div className="brand-lockup">
            <img className="brand-icon" src="/media/app-icon.png" alt="Clawdex icon" />
            <div>
              <div className="brand-name">{data?.brand?.name || "Clawdex"}</div>
              <div className="brand-tag">{data?.brand?.tag || "Private mobile control"}</div>
            </div>
          </div>
          <div className="nav-meta">
            <span>{pulse?.bridgeMode || "Private localhost bridge"}</span>
            <span>{pulse?.transport || "REST + SSE"}</span>
          </div>
        </nav>

        <div className="hero-grid">
          <div className="hero-copy">
            <p className="eyebrow">{data?.hero?.eyebrow || "Private mobile control"}</p>
            <h1>{data?.hero?.title || "Your coding agent, off your desk."}</h1>
            <p className="hero-body">
              {data?.hero?.body ||
                "Review diffs, answer approvals, start previews, and keep full-stack work moving from your phone."}
            </p>

            <div className="hero-actions">
              <a className="primary-action" href="#join">
                {data?.hero?.secondaryCta || "Join the waitlist"}
              </a>
              <a className="secondary-action" href="#workflow">
                {data?.hero?.primaryCta || "Open live preview"}
              </a>
            </div>

            <div className="hero-proof">
              {proof.map((item) => (
                <div key={item.label} className="proof-item">
                  <span>{item.label}</span>
                  <strong>{item.value}</strong>
                </div>
              ))}
            </div>
          </div>

          <div className="hero-media">
            <div className="desktop-glow" />
            {shotSet.map((shot) => (
              <figure key={shot.src} className={shot.kind}>
                <img src={shot.src} alt={shot.alt} />
              </figure>
            ))}
          </div>
        </div>
      </header>

      <section className="signal-strip" aria-label="Backend-powered status">
        <div className="signal-copy">
          <span className="signal-kicker">Live backend signal</span>
          <strong>{waitlistLabel}</strong>
        </div>
        <div className="signal-copy">
          <span className="signal-kicker">Latest interest</span>
          <strong>{pulse?.latestInterest || "Preview websites from mobile"}</strong>
        </div>
        <div className="signal-copy">
          <span className="signal-kicker">Latest signup</span>
          <strong>{pulse?.latestSignup || "No signups yet"}</strong>
        </div>
      </section>

      <main>
        <section className="workflow-section" id="workflow">
          <div className="section-heading">
            <p className="eyebrow">Full-stack preview path</p>
            <h2>The desktop machine stays real. The phone stays useful.</h2>
          </div>

          <div className="workflow-grid">
            <div className="workflow-copy">
              {workflow.map((item) => (
                <article key={item.title} className="workflow-step">
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                </article>
              ))}
            </div>

            <div className="wide-stage">
              <img
                src="/media/ipad-manage-threads.png"
                alt="Clawdex iPad screenshot showing active threads"
              />
            </div>
          </div>
        </section>

        <section className="detail-rail" aria-label="Product detail">
          {railShots.map((shot, index) => (
            <article key={shot.title} className="detail-item">
              <div className="detail-copy">
                <span className="detail-index">0{index + 1}</span>
                <h3>{shot.title}</h3>
                <p>{shot.copy}</p>
              </div>
              <div className="detail-media">
                <img src={shot.src} alt={shot.alt} />
              </div>
            </article>
          ))}
        </section>

        <section className="stats-section" aria-label="Clawdex stats">
          {stats.map((item) => (
            <div key={item.label} className="stat-line">
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </div>
          ))}
        </section>

        <section className="join-section" id="join">
          <div className="join-copy">
            <p className="eyebrow">Waitlist</p>
            <h2>Try the phone-first web workflow against a real localhost stack.</h2>
            <p>
              This form posts to a separate backend origin and updates the live status rail through
              SSE. It is meant to prove the browser preview path, not just decorate it.
            </p>
          </div>

          <form className="join-form" onSubmit={handleSubmit}>
            <label>
              <span>Email</span>
              <input
                type="email"
                placeholder="you@company.com"
                value={form.email}
                onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
                required
              />
            </label>

            <label>
              <span>What would you ship from mobile?</span>
              <input
                type="text"
                value={form.interest}
                onChange={(event) =>
                  setForm((current) => ({ ...current, interest: event.target.value }))
                }
              />
            </label>

            <button type="submit" disabled={submitState.type === "loading"}>
              {submitState.type === "loading" ? "Saving..." : "Join the demo list"}
            </button>
            <p className={`form-message ${submitState.type}`}>{submitState.message}</p>
          </form>
        </section>
      </main>
    </div>
  );
}

export default App;
