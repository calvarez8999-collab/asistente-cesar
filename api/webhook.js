import Anthropic from "@anthropic-ai/sdk";
import { Client as NotionClient } from "@notionhq/client";
import { Redis } from "@upstash/redis";
import { google } from "googleapis";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const notion = new NotionClient({ auth: process.env.NOTION_API_KEY });
const redis = Redis.fromEnv();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
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

const CHAT_ID_CESAR = process.env.TELEGRAM_CHAT_ID;

const SYSTEM_PROMPT = `Eres el asistente personal de César Álvarez. Operas por Telegram.

REGLAS DE COMUNICACIÓN:
- Siempre en español, sin excepción
- Respuestas cortas y directas
- Nunca preguntes más de una cosa a la vez
- Tono cercano y claro

━━━ TIPO 1: RECORDATORIOS → Google Calendar ━━━

Son eventos con fecha Y hora específica. NO van a Notion.

César tiene 3 calendarios:
- "personal" → su calendario personal
- "solica" → temas de paneles solares
- "visitas" → citas confirmadas con clientes

FLUJO:
1. Identifica: qué, fecha, hora
2. Si falta fecha u hora → pregunta solo eso
3. Si no menciona el calendario → pregunta: "¿Lo agendo en Personal, Solica o Visitas?"
4. Confirmación:

📅 NUEVO RECORDATORIO EN CALENDAR
✅ Título: [qué]
✅ Fecha: [día y fecha]
✅ Hora: [hora]
✅ Calendario: [Personal/Solica/Visitas]
⏰ Recordatorio: 30 min antes

¿Confirmas?

5. Si confirma → usa crear_evento_calendar
6. Confirma: "✅ Agendado en [calendario]: [título] — [fecha] a las [hora]"

REGLA ESPECIAL PARA VISITAS:
Crea DOS eventos automáticamente:
1. La visita en calendario "visitas"
2. Recordatorio de confirmación en calendario "personal":
   - Visita en mañana (antes 12pm) → recordatorio día anterior a las 4:00pm
   - Visita en tarde (12pm o después) → recordatorio día anterior a las 8:00am
   Título: "⚠️ Confirmar visita mañana: [título]"

━━━ TIPO 2: TAREAS → Notion ━━━

CAMPOS OBLIGATORIOS:
- Tarea, Tipo (Solica/Personal), Estado (default: En espera), Prioridad (Alta/Media/Baja), Responsable (default: Cesar Alvarez)

FLUJO:
1. Extrae datos, aplica defaults
2. Pregunta campos faltantes uno por uno
3. Confirmación → guardar_en_notion

━━━ EVENTOS VENCIDOS ━━━
Cuando el resumen muestre eventos de Calendar del día anterior sin borrar,
pregunta: "¿Completaste [evento]? Responde sí o reprograma para [fecha]"
Si dice "no, para mañana" → usa mover_evento_calendar
Si dice "sí" → usa eliminar_evento_calendar

━━━ COMANDOS RÁPIDOS ━━━
- "buenos días" / resumen 8am → usar obtener_resumen_dia
- "resumen" / "mis pendientes" → usar obtener_resumen_dia
- "qué tengo en el calendario" → usar obtener_eventos_calendar
- "completé [tarea]" → marcar completado en Notion
- "mueve [evento] a [fecha]" → mover_evento_calendar
- "elimina [evento]" → eliminar_evento_calendar

IMPORTANTE: Eres flexible, no hagas preguntas innecesarias si ya tienes todos los datos.`;

const tools = [
  {
    name: "guardar_en_notion",
    description: "Guarda una tarea en Notion. Solo cuando todos los campos obligatorios estén confirmados.",
    input_schema: {
      type: "object",
      properties: {
        tarea: { type: "string" },
        tipo: { type: "string", enum: ["Solica", "Personal"] },
        estado: { type: "string", enum: ["En espera", "En progreso", "Completado"] },
        prioridad: { type: "string", enum: ["Alta", "Media", "Baja"] },
        responsable: { type: "string" },
        fecha_limite: { type: "string" },
        notas: { type: "string" },
      },
      required: ["tarea", "tipo", "estado", "prioridad", "responsable"],
    },
  },
  {
    name: "obtener_tareas",
    description: "Obtiene tareas pendientes de Notion",
    input_schema: {
      type: "object",
      properties: {
        filtro: { type: "string", enum: ["todas", "alta_prioridad", "hoy"] },
      },
      required: ["filtro"],
    },
  },
  {
    name: "crear_evento_calendar",
    description: "Crea un evento en Google Calendar con fecha y hora específica.",
    input_schema: {
      type: "object",
      properties: {
        titulo: { type: "string" },
        fecha_hora_inicio: { type: "string", description: "ISO 8601, ej: 2026-04-05T15:00:00" },
        fecha_hora_fin: { type: "string" },
        descripcion: { type: "string" },
        es_todo_el_dia: { type: "boolean" },
        calendario: { type: "string", enum: ["personal", "solica", "visitas"] },
      },
      required: ["titulo", "fecha_hora_inicio", "calendario"],
    },
  },
  {
    name: "obtener_eventos_calendar",
    description: "Obtiene próximos eventos de Google Calendar",
    input_schema: {
      type: "object",
      properties: {
        dias: { type: "number" },
      },
      required: [],
    },
  },
  {
    name: "eliminar_evento_calendar",
    description: "Elimina un evento de Google Calendar por su ID",
    input_schema: {
      type: "object",
      properties: {
        evento_id: { type: "string", description: "ID del evento a eliminar" },
        calendario: { type: "string", enum: ["personal", "solica", "visitas"] },
      },
      required: ["evento_id", "calendario"],
    },
  },
  {
    name: "mover_evento_calendar",
    description: "Mueve un evento a otra fecha/hora eliminando el anterior y creando uno nuevo",
    input_schema: {
      type: "object",
      properties: {
        evento_id: { type: "string" },
        calendario: { type: "string", enum: ["personal", "solica", "visitas"] },
        nueva_fecha_hora: { type: "string", description: "Nueva fecha/hora ISO 8601" },
        titulo: { type: "string" },
      },
      required: ["evento_id", "calendario", "nueva_fecha_hora", "titulo"],
    },
  },
  {
    name: "obtener_resumen_dia",
    description: "Obtiene resumen completo del día: eventos de Calendar + tareas Notion + eventos vencidos",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];

async function guardarEnNotion(datos) {
  const properties = {
    Tarea: { title: [{ text: { content: datos.tarea } }] },
    Tipo: { select: { name: datos.tipo } },
    Estado: { status: { name: datos.estado } },
    Prioridad: { select: { name: datos.prioridad } },
    Responsable: { select: { name: datos.responsable } },
  };
  if (datos.fecha_limite) properties["Fecha límite"] = { date: { start: datos.fecha_limite } };
  if (datos.notas) properties["Notas"] = { rich_text: [{ text: { content: datos.notas } }] };
  await notion.pages.create({ parent: { database_id: NOTION_DB_ID }, properties });
}

async function obtenerTareas(filtro) {
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

  if (!tareas.length) return "No tienes pendientes activos. ✅";

  const cesar = tareas.filter((t) => t.responsable === "Cesar Alvarez");
  const rosa = tareas.filter((t) => t.responsable === "Rosa Ventura");

  let texto = "📋 TAREAS PENDIENTES\n\n";

  if (cesar.length) {
    texto += "👤 CÉSAR\n";
    ["Alta", "Media", "Baja"].forEach((p) => {
      const grupo = cesar.filter((t) => t.prioridad === p);
      if (grupo.length) {
        const emoji = p === "Alta" ? "🔴" : p === "Media" ? "🟡" : "🟢";
        grupo.forEach((t) => (texto += `${emoji} ${t.tarea}${t.fechaLimite ? " — " + t.fechaLimite : ""}\n`));
      }
    });
  }

  if (rosa.length) {
    texto += "\n👤 ROSA\n";
    rosa.forEach((t) => {
      const emoji = t.prioridad === "Alta" ? "🔴" : t.prioridad === "Media" ? "🟡" : "🟢";
      texto += `${emoji} ${t.tarea}\n`;
    });
  }

  return texto;
}

function buildCalendarEvent(titulo, inicio, fin, descripcion) {
  return {
    summary: titulo,
    start: { dateTime: inicio, timeZone: "America/Mexico_City" },
    end: { dateTime: fin, timeZone: "America/Mexico_City" },
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 30 }] },
    ...(descripcion ? { description: descripcion } : {}),
  };
}

async function crearEventoCalendar(datos) {
  const calendarId = CALENDARIOS[datos.calendario] || CALENDARIOS.personal;

  let event;
  if (datos.es_todo_el_dia) {
    const fechaSolo = datos.fecha_hora_inicio.split("T")[0];
    event = { summary: datos.titulo, start: { date: fechaSolo }, end: { date: fechaSolo } };
  } else {
    const inicio = datos.fecha_hora_inicio;
    const fin = datos.fecha_hora_fin || new Date(new Date(inicio).getTime() + 3600000).toISOString().slice(0, 19);
    event = buildCalendarEvent(datos.titulo, inicio, fin, datos.descripcion);
  }

  const result = await calendarClient.events.insert({ calendarId, resource: event });

  if (datos.calendario === "visitas" && !datos.es_todo_el_dia) {
    const fechaVisita = new Date(datos.fecha_hora_inicio);
    const esMañana = fechaVisita.getHours() < 12;
    const diaAnterior = new Date(fechaVisita);
    diaAnterior.setDate(diaAnterior.getDate() - 1);
    const fechaStr = diaAnterior.toISOString().split("T")[0];
    const horaInicio = esMañana ? "16:00:00" : "08:00:00";
    const horaFin = esMañana ? "16:30:00" : "08:30:00";

    await calendarClient.events.insert({
      calendarId: CALENDARIOS.personal,
      resource: buildCalendarEvent(
        `⚠️ Confirmar visita mañana: ${datos.titulo}`,
        `${fechaStr}T${horaInicio}`,
        `${fechaStr}T${horaFin}`,
        "Reconfirmar cita del día siguiente"
      ),
    });

    return `✅ Visita agendada: ${datos.titulo}\n⏰ Recordatorio de confirmación: día anterior a las ${esMañana ? "4:00pm" : "8:00am"}`;
  }

  return `✅ Agendado en ${datos.calendario}: ${result.data.summary} — ${result.data.start.dateTime || result.data.start.date}`;
}

async function eliminarEventoCalendar(eventoId, calendario) {
  const calendarId = CALENDARIOS[calendario] || CALENDARIOS.personal;
  await calendarClient.events.delete({ calendarId, eventId: eventoId });
  return "Evento eliminado.";
}

async function moverEventoCalendar(datos) {
  const calendarId = CALENDARIOS[datos.calendario] || CALENDARIOS.personal;
  await calendarClient.events.delete({ calendarId, eventId: datos.evento_id });
  const nuevaFin = new Date(new Date(datos.nueva_fecha_hora).getTime() + 3600000).toISOString().slice(0, 19);
  const nuevoEvento = buildCalendarEvent(datos.titulo, datos.nueva_fecha_hora, nuevaFin, null);
  await calendarClient.events.insert({ calendarId, resource: nuevoEvento });
  return `✅ Evento movido: ${datos.titulo} → ${datos.nueva_fecha_hora}`;
}

async function obtenerResumenDia() {
  const ahoraMX = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Mexico_City" }));
  const hoyStr = ahoraMX.toISOString().split("T")[0];

  // Eventos de hoy en todos los calendarios
  const inicioHoy = new Date(`${hoyStr}T00:00:00`).toISOString();
  const finHoy = new Date(`${hoyStr}T23:59:59`).toISOString();

  // Eventos vencidos (ayer)
  const ayer = new Date(ahoraMX);
  ayer.setDate(ayer.getDate() - 1);
  const ayerStr = ayer.toISOString().split("T")[0];
  const inicioAyer = new Date(`${ayerStr}T00:00:00`).toISOString();
  const finAyer = new Date(`${ayerStr}T23:59:59`).toISOString();

  const [eventosHoy, eventosAyer, tareas] = await Promise.all([
    calendarClient.events.list({
      calendarId: "primary", timeMin: inicioHoy, timeMax: finHoy,
      singleEvents: true, orderBy: "startTime",
    }),
    calendarClient.events.list({
      calendarId: "primary", timeMin: inicioAyer, timeMax: finAyer,
      singleEvents: true,
    }),
    obtenerTareas("todas"),
  ]);

  let resumen = `📅 RESUMEN — ${ahoraMX.toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" })}\n\n`;

  const vencidos = eventosAyer.data.items || [];
  if (vencidos.length) {
    resumen += "⚠️ PENDIENTES DE AYER:\n";
    vencidos.forEach((ev) => {
      resumen += `  • ${ev.summary} (ID: ${ev.id})\n`;
    });
    resumen += "¿Los completaste? Dime cuáles sí y cuáles no.\n\n";
  }

  const hoy = eventosHoy.data.items || [];
  if (hoy.length) {
    resumen += "📆 HOY EN CALENDAR:\n";
    hoy.forEach((ev) => {
      const hora = ev.start.dateTime
        ? new Date(ev.start.dateTime).toLocaleTimeString("es-MX", { timeZone: "America/Mexico_City", hour: "2-digit", minute: "2-digit" })
        : "todo el día";
      resumen += `  • ${hora} — ${ev.summary}\n`;
    });
    resumen += "\n";
  }

  resumen += tareas;
  return resumen;
}

async function enviarMensaje(chatId, texto) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: "HTML" }),
  });
}

async function transcribirAudio(fileId) {
  const fileRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
  const fileData = await fileRes.json();
  await fetch(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileData.result.file_path}`);
  return "[Audio recibido — transcripción próximamente. Por favor escribe tu mensaje.]";
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).json({ ok: true });

  const { message } = req.body;
  if (!message) return res.status(200).json({ ok: true });

  const chatId = message.chat.id;
  const texto = message.text || "";
  const voz = message.voice || null;

  let historial = (await redis.get(`chat:${chatId}`)) || [];

  const ahora = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Mexico_City" }));
  const toISO = (d) => d.toISOString().split("T")[0];
  const manana = new Date(ahora); manana.setDate(ahora.getDate() + 1);
  const pasado = new Date(ahora); pasado.setDate(ahora.getDate() + 2);

  const systemPromptConFecha = SYSTEM_PROMPT + `\n\nFECHAS DE REFERENCIA:
- Hoy: ${toISO(ahora)}
- Mañana: ${toISO(manana)}
- Pasado mañana: ${toISO(pasado)}`;

  let mensajeUsuario = texto;
  if (voz && !texto) mensajeUsuario = await transcribirAudio(voz.file_id);
  if (!mensajeUsuario) return res.status(200).json({ ok: true });

  historial.push({ role: "user", content: mensajeUsuario });
  if (historial.length > 20) historial = historial.slice(-20);

  try {
    const respuesta = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: systemPromptConFecha,
      tools,
      messages: historial,
    });

    let textoRespuesta = "";
    const contenidoAsistente = respuesta.content;

    for (const bloque of contenidoAsistente) {
      if (bloque.type === "text") {
        textoRespuesta += bloque.text;
      } else if (bloque.type === "tool_use") {
        let resultadoHerramienta = "";

        if (bloque.name === "guardar_en_notion") {
          await guardarEnNotion(bloque.input);
          resultadoHerramienta = "Tarea guardada en Notion.";
        } else if (bloque.name === "obtener_tareas") {
          resultadoHerramienta = await obtenerTareas(bloque.input.filtro);
        } else if (bloque.name === "crear_evento_calendar") {
          resultadoHerramienta = await crearEventoCalendar(bloque.input);
        } else if (bloque.name === "obtener_eventos_calendar") {
          resultadoHerramienta = await obtenerEventosCalendar(bloque.input.dias || 7);
        } else if (bloque.name === "eliminar_evento_calendar") {
          resultadoHerramienta = await eliminarEventoCalendar(bloque.input.evento_id, bloque.input.calendario);
        } else if (bloque.name === "mover_evento_calendar") {
          resultadoHerramienta = await moverEventoCalendar(bloque.input);
        } else if (bloque.name === "obtener_resumen_dia") {
          resultadoHerramienta = await obtenerResumenDia();
        }

        historial.push({ role: "assistant", content: contenidoAsistente });
        historial.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: bloque.id, content: resultadoHerramienta }],
        });

        const respuestaFinal = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 512,
          system: systemPromptConFecha,
          tools,
          messages: historial,
        });

        textoRespuesta = respuestaFinal.content.find((b) => b.type === "text")?.text || resultadoHerramienta;
        historial.push({ role: "assistant", content: respuestaFinal.content });
      }
    }

    if (!textoRespuesta.includes("tool_use")) {
      historial.push({ role: "assistant", content: contenidoAsistente });
    }

    await redis.set(`chat:${chatId}`, historial.slice(-20), { ex: 86400 });
    if (textoRespuesta) await enviarMensaje(chatId, textoRespuesta);

  } catch (error) {
    console.error("Error:", error);
    if (error?.status === 400 && error?.message?.includes("tool_use")) {
      await redis.del(`chat:${chatId}`);
      await enviarMensaje(chatId, "Reiniciando conversación. Por favor repite tu mensaje.");
    } else {
      await enviarMensaje(chatId, "Hubo un error procesando tu mensaje. Intenta de nuevo.");
    }
  }

  return res.status(200).json({ ok: true });
}
