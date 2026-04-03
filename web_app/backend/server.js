import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = Number(process.env.PORT || 3003);
const waitlistFile = path.join(__dirname, "data", "waitlist.json");
const pulseClients = new Set();

const landingContent = {
  brand: {
    name: "Clawdex",
    tag: "Private bridge for Codex and OpenCode",
  },
  hero: {
    eyebrow: "Private mobile control",
    title: "Your coding agent, off your desk.",
    body:
      "Review diffs, answer approvals, start previews, and keep full-stack work moving from your phone while the real code keeps running on your own machine.",
    primaryCta: "Open live preview",
    secondaryCta: "Join the waitlist",
  },
  proof: [
    { label: "Private network", value: "Your machine stays the source of truth" },
    { label: "Live approvals", value: "Review commands and patches before they land" },
    { label: "Desktop preview", value: "Check mobile and desktop layouts from the phone" },
  ],
  workflow: [
    {
      title: "Launch work from the thread you already started",
      body: "Clawdex keeps thread context, active tasks, and recent outputs close enough to act on in a few seconds.",
    },
    {
      title: "Review what changed before anything lands",
      body: "Approvals, git diffs, terminal actions, and browser previews stay inside the same private session loop.",
    },
    {
      title: "Keep full-stack previews connected",
      body: "Frontend and backend can both stay on localhost while the phone sees the same workflow through the bridge.",
    },
  ],
  stats: [
    { label: "Average unblock time", value: "14 sec" },
    { label: "Threads managed", value: "Multi-session" },
    { label: "Preview path", value: "Frontend + backend" },
  ],
  footer: {
    prompt: "Build the next site from your phone without losing the desktop machine behind it.",
  },
};

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

function maskEmail(email) {
  const [name, domain] = email.split("@");
  if (!name || !domain) {
    return email;
  }
  if (name.length < 3) {
    return `${name[0] || "*"}***@${domain}`;
  }
  return `${name.slice(0, 2)}***${name.slice(-1)}@${domain}`;
}

async function readWaitlist() {
  try {
    const raw = await fs.readFile(waitlistFile, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeWaitlist(entries) {
  await fs.writeFile(waitlistFile, JSON.stringify(entries, null, 2));
}

async function buildPulsePayload() {
  const entries = await readWaitlist();
  const latest = entries.at(-1);
  return {
    waitlistCount: entries.length,
    latestInterest: latest?.interest || "Mobile browser preview",
    latestSignup: latest ? maskEmail(latest.email) : "No signups yet",
    bridgeMode: "Private localhost bridge",
    transport: "REST + SSE over separate origins",
    updatedAt: new Date().toISOString(),
  };
}

async function broadcastPulse() {
  if (pulseClients.size === 0) {
    return;
  }
  const payload = JSON.stringify(await buildPulsePayload());
  for (const client of pulseClients) {
    client.write(`event: pulse\n`);
    client.write(`data: ${payload}\n\n`);
  }
}

app.get("/health", async (_req, res) => {
  const pulse = await buildPulsePayload();
  res.json({ ok: true, service: "clawdex-demo-backend", pulse });
});

app.get("/api/landing", async (_req, res) => {
  const pulse = await buildPulsePayload();
  res.json({
    ...landingContent,
    pulse,
  });
});

app.get("/api/waitlist", async (_req, res) => {
  const entries = await readWaitlist();
  res.json({
    count: entries.length,
    recent: entries.slice(-5).reverse().map((entry) => ({
      email: maskEmail(entry.email),
      interest: entry.interest,
      createdAt: entry.createdAt,
    })),
  });
});

app.post("/api/waitlist", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const interest = String(req.body?.interest || "").trim() || "Mobile browser preview";

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ ok: false, error: "Enter a valid email address." });
    return;
  }

  const entries = await readWaitlist();
  const duplicate = entries.find((entry) => entry.email === email);
  if (duplicate) {
    res.json({
      ok: true,
      duplicate: true,
      message: "Already on the list.",
      count: entries.length,
    });
    return;
  }

  entries.push({
    email,
    interest,
    createdAt: new Date().toISOString(),
  });
  await writeWaitlist(entries);
  await broadcastPulse();
  res.status(201).json({
    ok: true,
    message: "Saved to the Clawdex demo waitlist.",
    count: entries.length,
  });
});

app.get("/api/pulse", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  pulseClients.add(res);
  const sendCurrent = async () => {
    res.write(`event: pulse\n`);
    res.write(`data: ${JSON.stringify(await buildPulsePayload())}\n\n`);
  };

  await sendCurrent();
  const interval = setInterval(sendCurrent, 5000);

  req.on("close", () => {
    clearInterval(interval);
    pulseClients.delete(res);
    res.end();
  });
});

app.listen(port, "127.0.0.1", () => {
  console.log(`Clawdex demo backend running on http://127.0.0.1:${port}`);
});
