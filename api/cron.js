import { Redis } from "@upstash/redis";
import { Client as NotionClient } from "@notionhq/client";
import { google } from "googleapis";

const redis = Redis.fromEnv();
const notion = new NotionClient({ auth: process.env.NOTION_API_KEY });
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const NOTION_DB_ID = process.env.NOTION_DATABASE_ID;

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  "https://developers.google.com/oauthplayground"
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const calendarClient = google.calendar({ version: "v3", auth: oauth2Client });

const CALENDARIOS = {
  personal: "primary",
  solica: "c1d66bb9cd3e50fd52377494c37ce02f0f53a0d1b9dcdff2fd4bb51bdeb9f87d@group.calendar.google.com",
  visitas: "family08279346636537420740@group.calendar.google.com",
};

async function enviarMensaje(texto) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: texto }),
  });
}

async function obtenerEventosVencidos() {
  const ahoraMX = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Mexico_City" }));
  const ayer = new Date(ahoraMX);
  ayer.setDate(ayer.getDate() - 1);
  const ayerStr = ayer.toISOString().split("T")[0];

  const vencidos = [];
  for (const [nombre, calId] of Object.entries(CALENDARIOS)) {
    const res = await calendarClient.events.list({
      calendarId: calId,
      timeMin: new Date(`${ayerStr}T00:00:00`).toISOString(),
      timeMax: new Date(`${ayerStr}T23:59:59`).toISOString(),
      singleEvents: true,
    });
    (res.data.items || []).forEach((ev) => {
      if (!ev.summary?.startsWith("⚠️")) {
        vencidos.push({ titulo: ev.summary, id: ev.id, calendario: nombre });
      }
    });
  }
  return vencidos;
}

async function obtenerEventosHoy() {
  const ahoraMX = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Mexico_City" }));
  const hoyStr = ahoraMX.toISOString().split("T")[0];

  const eventos = [];
  for (const [nombre, calId] of Object.entries(CALENDARIOS)) {
    const res = await calendarClient.events.list({
      calendarId: calId,
      timeMin: new Date(`${hoyStr}T00:00:00`).toISOString(),
      timeMax: new Date(`${hoyStr}T23:59:59`).toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });
    (res.data.items || []).forEach((ev) => {
      eventos.push({ titulo: ev.summary, inicio: ev.start.dateTime || ev.start.date, calendario: nombre });
    });
  }
  eventos.sort((a, b) => new Date(a.inicio) - new Date(b.inicio));
  return eventos;
}

async function obtenerTareasNotion() {
  const response = await notion.databases.query({
    database_id: NOTION_DB_ID,
    filter: { property: "Estado", status: { does_not_equal: "Completado" } },
    sorts: [{ property: "Prioridad", direction: "descending" }],
    page_size: 15,
  });

  const tareas = response.results.map((page) => {
    const props = page.properties;
    return {
      tarea: props.Tarea?.title?.[0]?.text?.content || "Sin título",
      prioridad: props.Prioridad?.select?.name || "—",
      responsable: props.Responsable?.select?.name || "—",
      fechaLimite: props["Fecha límite"]?.date?.start || null,
    };
  });
  return tareas;
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(200).json({ ok: true });

  try {
    const ahoraMX = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Mexico_City" }));
    const hora = ahoraMX.getHours();
    const esMañana = hora < 12;

    const fechaTexto = ahoraMX.toLocaleDateString("es-MX", {
      weekday: "long", day: "numeric", month: "long"
    });

    const [vencidos, eventosHoy, tareas] = await Promise.all([
      obtenerEventosVencidos(),
      obtenerEventosHoy(),
      obtenerTareasNotion(),
    ]);

    let mensaje = `${esMañana ? "🌅 RESUMEN MATUTINO" : "🌆 RESUMEN VESPERTINO"} — ${fechaTexto}\n\n`;

    if (vencidos.length) {
      mensaje += "⚠️ PENDIENTES DE AYER SIN COMPLETAR:\n";
      vencidos.forEach((ev) => (mensaje += `  • ${ev.titulo} [${ev.calendario}]\n`));
      mensaje += "¿Los completaste? Dime cuáles sí y cuáles reprogramamos.\n\n";
    }

    if (eventosHoy.length) {
      mensaje += "📅 HOY EN CALENDAR:\n";
      eventosHoy.forEach((ev) => {
        const hora = ev.inicio.includes("T")
          ? new Date(ev.inicio).toLocaleTimeString("es-MX", {
              timeZone: "America/Mexico_City",
              hour: "2-digit", minute: "2-digit",
            })
          : "todo el día";
        mensaje += `  • ${hora} — ${ev.titulo} [${ev.calendario}]\n`;
      });
      mensaje += "\n";
    }

    const cesar = tareas.filter((t) => t.responsable === "Cesar Alvarez");
    const rosa = tareas.filter((t) => t.responsable === "Rosa Ventura");

    if (cesar.length) {
      mensaje += "📋 TUS TAREAS NOTION:\n";
      ["Alta", "Media", "Baja"].forEach((p) => {
        const emoji = p === "Alta" ? "🔴" : p === "Media" ? "🟡" : "🟢";
        cesar.filter((t) => t.prioridad === p).forEach((t) => {
          mensaje += `${emoji} ${t.tarea}${t.fechaLimite ? " — " + t.fechaLimite : ""}\n`;
        });
      });
    }

    if (rosa.length) {
      mensaje += "\n👤 TAREAS DE ROSA:\n";
      rosa.forEach((t) => {
        const emoji = t.prioridad === "Alta" ? "🔴" : t.prioridad === "Media" ? "🟡" : "🟢";
        mensaje += `${emoji} ${t.tarea}\n`;
      });
    }

    if (!vencidos.length && !eventosHoy.length && !tareas.length) {
      mensaje += "✅ Sin pendientes. ¡Día despejado!";
    }

    await enviarMensaje(mensaje);
    return res.status(200).json({ ok: true });

  } catch (error) {
    console.error("Error cron:", error);
    return res.status(500).json({ error: error.message });
  }
}
