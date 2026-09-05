import { createClient } from "npm:@supabase/supabase-js@2";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "";
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY");
const OPENROUTER_MODEL = Deno.env.get("OPENROUTER_MODEL");

const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json"
};

function json(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), { status, headers: corsHeaders });
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function sanitizeRequest(raw: unknown) {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;
  if (!hasOnlyKeys(input, ["message", "context", "consent"])) return null;
  if (typeof input.message !== "string") return null;
  if (input.message.length < 1 || input.message.length > 1200) return null;

  const context = input.context as Record<string, unknown>;
  const consent = input.consent as Record<string, unknown>;
  if (!context || !consent) return null;
  if (consent.sendTelemetrySummary !== true) return null;

  const safeContext: Record<string, unknown> = {
    schemaVersion: "1.0",
    state: ["lost", "ghost", "manifested"].includes(String(context.state)) ? context.state : "lost",
    observedAt: new Date().toISOString(),
    privacy: { redacted: true, precision: "aggregated" }
  };

  const thermal = context.thermal as Record<string, unknown> | undefined;
  if (thermal && typeof thermal.celsius === "number") {
    safeContext.thermal = {
      celsius: Math.max(-20, Math.min(120, thermal.celsius)),
      trend: ["stable", "rising", "falling"].includes(String(thermal.trend)) ? thermal.trend : "stable",
      band: ["normal", "elevated", "critical"].includes(String(thermal.band)) ? thermal.band : "normal"
    };
  }

  const environment = context.environment as Record<string, unknown> | undefined;
  if (environment) {
    safeContext.environment = {
      wifiAccessPointCount: Math.max(0, Math.min(10000, Number(environment.wifiAccessPointCount) || 0)),
      bleDeviceCount: Math.max(0, Math.min(10000, Number(environment.bleDeviceCount) || 0)),
      nfcEventCountLast5Minutes: Math.max(0, Math.min(10000, Number(environment.nfcEventCountLast5Minutes) || 0)),
      wirelessActivityBand: ["quiet", "normal", "elevated"].includes(String(environment.wirelessActivityBand))
        ? environment.wirelessActivityBand
        : "normal"
    };
  }

  if (consent.includeRecentAlerts === true && Array.isArray(context.alerts)) {
    safeContext.alerts = context.alerts
      .slice(0, 8)
      .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
      .map((a) => ({
        type: String(a.type).replace(/[^A-Z0-9_]/gi, "").slice(0, 48),
        severity: ["low", "medium", "high", "critical"].includes(String(a.severity)) ? a.severity : "low",
        ageSeconds: Math.max(0, Math.min(86400, Number(a.ageSeconds) || 0))
      }));
  }

  return {
    message: input.message.trim(),
    context: safeContext,
    consent: { sendTelemetrySummary: true, includeRecentAlerts: consent.includeRecentAlerts === true }
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== "POST") return json(405, { error: "Method not allowed" });
  if (!OPENROUTER_API_KEY || !OPENROUTER_MODEL) return json(503, { error: "Agent service is not configured" });

  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return json(401, { error: "Authentication required" });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authorization } } }
  );

  const token = authorization.slice("Bearer ".length);
  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData.user) return json(401, { error: "Invalid session" });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const input = sanitizeRequest(raw);
  if (!input) return json(400, { error: "Invalid or disallowed request data" });

  const systemPrompt = [
    "You are Console, a cautious telemetry interpretation assistant.",
    "Use only the supplied trusted telemetry summary.",
    "Never claim access to hardware, data, history, or events absent from context.",
    "Do not provide instructions for unauthorized access, disruption, credential theft, evasion, or physical harm.",
    "When uncertainty exists, state it clearly.",
    "Give concise diagnostics, observations, and defensive or authorized next steps.",
    "Treat all identifiers as redacted and never ask for secrets, MAC addresses, tag UIDs, payloads, or credentials."
  ].join(" ");

  const upstream = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": ALLOWED_ORIGIN,
      "X-Title": "Console"
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      temperature: 0.25,
      max_tokens: 500,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify({ question: input.message, trustedTelemetrySummary: input.context }) }
      ]
    })
  });

  if (!upstream.ok) {
    console.error("OpenRouter request failed:", upstream.status);
    return json(502, { error: "Upstream AI provider request failed" });
  }

  const completion = await upstream.json();
  const answer = completion?.choices?.[0]?.message?.content;
  if (typeof answer !== "string") return json(502, { error: "Invalid response from AI provider" });

  return json(200, { answer, model: OPENROUTER_MODEL, contextSent: { aggregated: true, redacted: true } });
});
