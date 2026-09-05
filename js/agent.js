// Agent client: talks only to your own Supabase Edge Function.
// Never sends an OpenRouter key from the browser. Only an aggregated,
// redacted telemetry summary plus the user's question is transmitted,
// and only after explicit user consent (Settings > Cloud Agent).

export function buildMinimalAgentContext(state) {
  return {
    schemaVersion: "1.0",
    state: state.mode,
    observedAt: new Date().toISOString(),
    thermal: state.thermal == null ? undefined : {
      celsius: state.thermal,
      trend: "stable",
      band: state.thermal >= 38 ? "critical" : state.thermal >= 33 ? "elevated" : "normal"
    },
    environment: {
      wifiAccessPointCount: state.aps ?? 0,
      bleDeviceCount: state.ble ?? 0,
      nfcEventCountLast5Minutes: state.nfcEvents ?? 0,
      wirelessActivityBand: (state.aps ?? 0) > 8 || (state.ble ?? 0) > 9 ? "elevated" : "normal"
    },
    alerts: (state.recentAlerts ?? []).slice(0, 8).map((a) => ({
      type: a.type,
      severity: a.severity,
      ageSeconds: Math.round((Date.now() - a.createdAt) / 1000)
    })),
    privacy: { redacted: true, precision: "aggregated" }
  };
}

export async function askAgent({ message, context, accessToken, functionUrl, includeAlerts }) {
  if (!functionUrl || !accessToken) {
    return { error: "cloud_agent_not_configured" };
  }

  const response = await fetch(functionUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({
      message,
      context,
      consent: { sendTelemetrySummary: true, includeRecentAlerts: !!includeAlerts }
    })
  });

  if (!response.ok) {
    return { error: `agent_http_${response.status}` };
  }

  return response.json();
}
