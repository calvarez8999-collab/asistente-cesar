import Anthropic from "@anthropic-ai/sdk";
import { Client as NotionClient } from "@notionhq/client";
import { Redis } from "@upstash/redis";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const notion = new NotionClient({ auth: process.env.NOTION_API_KEY });
const redis = Redis.fromEnv();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const NOTION_DB_ID = process.env.NOTION_DATABASE_ID;

const CALENDARIOS = {
  personal: "primary",
  solica: "f1ee38b2733af13f35a91c4c7350a79b3545afdb5fe06c0bd41b9e9b0fe158e8@group.calendar.google.com",
  visitas: "family08279346636537420740@group.calendar.google.com",
  seguimientos: "c1d66bb9cd3e50fd52377494c37ce02f0f53a0d1b9dcdff2fd4bb51bdeb9f87d@group.calendar.google.com",
};

// ─── Google Calendar: token manual ──────────────────────────────────────────
async function getAccessToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }).toString(),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("No se pudo obtener access token: " + JSON.stringify(data));
  return data.access_token;
}

async function calendarRequest(method, path, body = null) {
  const token = await getAccessToken();
  const res = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (method === "DELETE") return null;
  return res.json();
}

const SYSTEM_PROMPT = `Eres el asistente personal de César Álvarez. Operas por Telegram.

REGLAS DE COMUNICACIÓN:
- Siempre en español, sin excepción
- Respuestas cortas y directas
- Nunca preguntes más de una cosa a la vez
- Tono cercano y claro

━━━ TIPO 1: RECORDATORIOS → Google Calendar ━━━

César tiene 4 calendarios:
- "personal" → su calendario personal
- "solica" → temas de paneles solares
- "visitas" → citas confirmadas con clientes
- "seguimientos" → seguimiento de clientes y prospectos

FLUJO:
1. Identifica: qué, fecha, hora
2. Si falta fecha u hora → pregunta solo eso
3. SIEMPRE pregunta el calendario aunque creas saber cuál es. Nunca asumas Personal por default.
   Pregunta: "¿Lo agendo en Personal, Solica, Visitas o Seguimientos?"
4. Confirmación:

📅 NUEVO RECORDATORIO EN CALENDAR
✅ Título: [qué]
✅ Fecha: [día y fecha]
✅ Hora: [hora]
✅ Calendario: [Personal/Solica/Visitas]
⏰ Recordatorio: 30 min antes

¿Confirmas?

5. Si confirma → usar crear_evento_calendar
6. Confirma: "✅ Agendado en [calendario]: [título] — [fecha] a las [hora]"

REGLA ESPECIAL PARA VISITAS:
Crea DOS eventos:
1. La visita en calendario "visitas"
2. Recordatorio en "personal":
   - Visita en mañana (antes 12pm) → día anterior a las 4:00pm
   - Visita en tarde (12pm+) → día anterior a las 8:00am
   Título: "⚠️ Confirmar visita mañana: [título]"

━━━ TIPO 2: TAREAS → Notion ━━━

CAMPOS OBLIGATORIOS:
- Tarea, Tipo (Solica/Personal), Estado (default: En espera), Prioridad (Alta/Media/Baja), Responsable (default: Cesar Alvarez)

FLUJO:
1. Extrae datos, aplica defaults
2. Pregunta campos faltantes uno por uno
3. Confirmación → guardar_en_notion

━━━ COMANDOS RÁPIDOS ━━━
- "resumen" / "buenos días" → obtener_resumen_dia
- "mis pendientes" → obtener_tareas
- "qué tengo en el calendario" → obtener_eventos_calendar
- "completé [tarea]" / "marca como completado [tarea]" → actualizar_tarea_notion con estado "Completado"
- "cambia estado de [tarea] a [estado]" → actualizar_tarea_notion
- "elimina [evento]" → buscar_evento_calendar primero, luego eliminar_evento_calendar con el ID
- "mueve [evento] a [fecha]" → buscar_evento_calendar primero, luego mover_evento_calendar con el ID
- Puedes recibir mensajes de VOZ — se transcriben automáticamente

RESPONSABLES VÁLIDOS EN NOTION: "Cesar Alvarez" o "Rosa Ventura" — usa exactamente estos nombres.

FLUJO PARA ELIMINAR/MOVER EVENTOS:
1. Usa buscar_evento_calendar para encontrar el evento y obtener su ID
2. Muestra al usuario qué encontraste y confirma
3. Ejecuta eliminar_evento_calendar o mover_evento_calendar con el ID

IMPORTANTE: Eres flexible, no hagas preguntas innecesarias si ya tienes todos los datos.`;

const tools = [
  {
    name: "guardar_en_notion",
    description: "Guarda una tarea en Notion cuando todos los campos obligatorios están confirmados.",
    input_schema: {
      type: "object",
      properties: {
        tarea: { type: "string" },
        tipo: { type: "string", enum: ["Solica", "Personal"] },
        estado: { type: "string", enum: ["En espera", "En progreso", "Completado"] },
        prioridad: { type: "string", enum: ["Alta", "Media", "Baja"] },
        responsable: { type: "string", enum: ["Cesar Alvarez", "Rosa Ventura"] },
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
        calendario: { type: "string", enum: ["personal", "solica", "visitas", "seguimientos"] },
      },
      required: ["titulo", "fecha_hora_inicio", "calendario"],
    },
  },
  {
    name: "obtener_eventos_calendar",
    description: "Obtiene próximos eventos de Google Calendar",
    input_schema: {
      type: "object",
      properties: { dias: { type: "number" } },
      required: [],
    },
  },
  {
    name: "eliminar_evento_calendar",
    description: "Elimina un evento de Google Calendar por su ID",
    input_schema: {
      type: "object",
      properties: {
        evento_id: { type: "string" },
        calendario: { type: "string", enum: ["personal", "solica", "visitas", "seguimientos"] },
      },
      required: ["evento_id", "calendario"],
    },
  },
  {
    name: "mover_evento_calendar",
    description: "Mueve un evento a otra fecha/hora",
    input_schema: {
      type: "object",
      properties: {
        evento_id: { type: "string" },
        calendario: { type: "string", enum: ["personal", "solica", "visitas", "seguimientos"] },
        nueva_fecha_hora: { type: "string" },
        titulo: { type: "string" },
      },
      required: ["evento_id", "calendario", "nueva_fecha_hora", "titulo"],
    },
  },
  {
    name: "obtener_resumen_dia",
    description: "Obtiene resumen del día: eventos Calendar + tareas Notion + eventos vencidos",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "actualizar_tarea_notion",
    description: "Actualiza el estado de una tarea en Notion buscándola por nombre",
    input_schema: {
      type: "object",
      properties: {
        nombre_tarea: { type: "string", description: "Nombre o parte del nombre de la tarea" },
        nuevo_estado: { type: "string", enum: ["En espera", "En progreso", "Completado"] },
      },
      required: ["nombre_tarea", "nuevo_estado"],
    },
  },
  {
    name: "buscar_evento_calendar",
    description: "Busca eventos en todos los calendarios por título para obtener su ID antes de eliminar o mover",
    input_schema: {
      type: "object",
      properties: {
        titulo: { type: "string", description: "Palabra o frase del título del evento" },
        dias: { type: "number", description: "Cuántos días hacia adelante buscar (default 14)" },
      },
      required: ["titulo"],
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

async function obtenerTareas() {
  const response = await notion.databases.query({
    database_id: NOTION_DB_ID,
    filter: { property: "Estado", status: { does_not_equal: "Completado" } },
    sorts: [{ property: "Prioridad", direction: "descending" }],
    page_size: 30,
  });

  const tareas = response.results.map((page) => {
    const props = page.properties;
    return {
      id: page.id,
      tarea: props.Tarea?.title?.[0]?.text?.content || "Sin título",
      tipo: props.Tipo?.select?.name || "—",
      prioridad: props.Prioridad?.select?.name || "—",
      responsable: props.Responsable?.select?.name || "—",
      fechaLimite: props["Fecha límite"]?.date?.start || null,
    };
  });

  if (!tareas.length) return "No tienes pendientes activos. ✅";

  const personas = [
    { nombre: "CÉSAR", filtro: "Cesar Alvarez", emoji: "👤" },
    { nombre: "ROSA", filtro: "Rosa Ventura", emoji: "👤" },
  ];

  let texto = "📋 TAREAS PENDIENTES\n";

  for (const persona of personas) {
    const porPersona = tareas.filter((t) => t.responsable === persona.filtro);
    if (!porPersona.length) continue;

    texto += `\n${persona.emoji} ${persona.nombre}\n`;

    for (const tipo of ["Solica", "Personal"]) {
      const porTipo = porPersona.filter((t) => t.tipo === tipo);
      if (!porTipo.length) continue;

      texto += `  📁 ${tipo.toUpperCase()}\n`;
      ["Alta", "Media", "Baja"].forEach((p) => {
        const emoji = p === "Alta" ? "🔴" : p === "Media" ? "🟡" : "🟢";
        porTipo.filter((t) => t.prioridad === p).forEach((t) => {
          texto += `    ${emoji} ${t.tarea}${t.fechaLimite ? " — " + t.fechaLimite : ""}\n`;
        });
      });
    }

    // Tipo desconocido
    const otros = porPersona.filter((t) => t.tipo !== "Solica" && t.tipo !== "Personal");
    if (otros.length) {
      texto += `  📁 OTROS\n`;
      otros.forEach((t) => {
        const emoji = t.prioridad === "Alta" ? "🔴" : t.prioridad === "Media" ? "🟡" : "🟢";
        texto += `    ${emoji} ${t.tarea}\n`;
      });
    }
  }

  return texto;
}

async function actualizarTareaNotion(nombreTarea, nuevoEstado) {
  // Intento 1: búsqueda con el término completo
  let response = await notion.databases.query({
    database_id: NOTION_DB_ID,
    filter: { property: "Tarea", title: { contains: nombreTarea } },
    page_size: 5,
  });

  // Intento 2: si no encuentra, prueba palabra por palabra (palabras > 3 chars)
  if (!response.results.length) {
    const palabras = nombreTarea.split(/\s+/).filter((p) => p.length > 3);
    for (const palabra of palabras) {
      response = await notion.databases.query({
        database_id: NOTION_DB_ID,
        filter: { property: "Tarea", title: { contains: palabra } },
        page_size: 5,
      });
      if (response.results.length) break;
    }
  }

  if (!response.results.length) return `No encontré ninguna tarea con "${nombreTarea}".`;

  if (response.results.length === 1) {
    const page = response.results[0];
    const titulo = page.properties.Tarea?.title?.[0]?.text?.content || "Sin título";
    await notion.pages.update({
      page_id: page.id,
      properties: { Estado: { status: { name: nuevoEstado } } },
    });
    return `✅ "${titulo}" → ${nuevoEstado}`;
  }

  // Más de 1 resultado — lista opciones
  const lista = response.results
    .map((p, i) => `${i + 1}. ${p.properties.Tarea?.title?.[0]?.text?.content || "Sin título"}`)
    .join("\n");
  return `Encontré varias tareas con ese nombre:\n${lista}\n¿A cuál te refieres?`;
}

async function buscarEventoCalendar(titulo, dias = 14) {
  const ahora = new Date();
  const hasta = new Date();
  hasta.setDate(hasta.getDate() + dias);

  const params = new URLSearchParams({
    timeMin: ahora.toISOString(),
    timeMax: hasta.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    q: titulo,
    maxResults: "10",
  });

  const etiquetas = { personal: "Personal", solica: "Solica", visitas: "Visitas", seguimientos: "Seguimientos" };
  const calIds = Object.entries(CALENDARIOS);

  const resultados = await Promise.all(
    calIds.map(([, id]) =>
      calendarRequest("GET", `/calendars/${encodeURIComponent(id)}/events?${params}`)
        .then((d) => d.items || []).catch(() => [])
    )
  );

  const eventos = calIds.flatMap(([nombre], i) =>
    resultados[i].map((ev) => ({ ...ev, _cal: nombre, _calLabel: etiquetas[nombre] }))
  );

  if (!eventos.length) return `No encontré eventos con "${titulo}" en los próximos ${dias} días.`;

  let texto = `Encontré estos eventos:\n`;
  eventos.forEach((ev) => {
    const hora = ev.start.dateTime
      ? new Date(ev.start.dateTime).toLocaleString("es-MX", {
          timeZone: "America/Mexico_City", weekday: "short", month: "short",
          day: "numeric", hour: "2-digit", minute: "2-digit",
        })
      : ev.start.date;
    texto += `  • [${ev._calLabel}] ${ev.summary} — ${hora}\n    ID: ${ev.id} | Cal: ${ev._cal}\n`;
  });
  return texto;
}

function buildEvent(titulo, inicio, fin, descripcion) {
  return {
    summary: titulo,
    start: { dateTime: inicio, timeZone: "America/Mexico_City" },
    end: { dateTime: fin, timeZone: "America/Mexico_City" },
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 30 }] },
    ...(descripcion ? { description: descripcion } : {}),
  };
}

async function crearEventoCalendar(datos) {
  const calId = CALENDARIOS[datos.calendario] || "primary";
  const encodedCalId = encodeURIComponent(calId);

  let event;
  if (datos.es_todo_el_dia) {
    const fechaSolo = datos.fecha_hora_inicio.split("T")[0];
    event = { summary: datos.titulo, start: { date: fechaSolo }, end: { date: fechaSolo } };
  } else {
    const inicio = datos.fecha_hora_inicio;
    const fin = datos.fecha_hora_fin || new Date(new Date(inicio).getTime() + 3600000).toISOString().slice(0, 19);
    event = buildEvent(datos.titulo, inicio, fin, datos.descripcion);
  }

  await calendarRequest("POST", `/calendars/${encodedCalId}/events`, event);

  if (datos.calendario === "visitas" && !datos.es_todo_el_dia) {
    const fechaVisita = new Date(datos.fecha_hora_inicio);
    const esMañana = fechaVisita.getHours() < 12;
    const diaAnterior = new Date(fechaVisita);
    diaAnterior.setDate(diaAnterior.getDate() - 1);
    const fechaStr = diaAnterior.toISOString().split("T")[0];
    const horaInicio = esMañana ? "16:00:00" : "08:00:00";
    const horaFin = esMañana ? "16:30:00" : "08:30:00";

    await calendarRequest(
      "POST",
      `/calendars/primary/events`,
      buildEvent(
        `⚠️ Confirmar visita mañana: ${datos.titulo}`,
        `${fechaStr}T${horaInicio}`,
        `${fechaStr}T${horaFin}`,
        "Reconfirmar cita del día siguiente"
      )
    );
    return `✅ Visita agendada: ${datos.titulo}\n⏰ Recordatorio: día anterior a las ${esMañana ? "4:00pm" : "8:00am"}`;
  }

  return `✅ Agendado en ${datos.calendario}: ${datos.titulo} — ${datos.fecha_hora_inicio}`;
}

async function obtenerEventosCalendar(dias = 7) {
  const ahora = new Date();
  const hasta = new Date();
  hasta.setDate(hasta.getDate() + dias);

  const params = new URLSearchParams({
    timeMin: ahora.toISOString(),
    timeMax: hasta.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "15",
  });

  const etiquetas = { personal: "Personal", solica: "Solica", visitas: "Visitas", seguimientos: "Seguimientos" };
  const calIds = Object.entries(CALENDARIOS);

  const resultados = await Promise.all(
    calIds.map(([, id]) =>
      calendarRequest("GET", `/calendars/${encodeURIComponent(id)}/events?${params}`)
        .then((d) => d.items || []).catch(() => [])
    )
  );

  const eventos = calIds.flatMap(([nombre], i) =>
    resultados[i].map((ev) => ({ ...ev, _cal: etiquetas[nombre] }))
  ).sort((a, b) => (a.start.dateTime || a.start.date) > (b.start.dateTime || b.start.date) ? 1 : -1);

  if (!eventos.length) return `No tienes eventos en los próximos ${dias} días. 📅`;

  let texto = `📅 TU AGENDA (próximos ${dias} días)\n\n`;
  eventos.forEach((ev) => {
    const hora = ev.start.dateTime
      ? new Date(ev.start.dateTime).toLocaleString("es-MX", {
          timeZone: "America/Mexico_City",
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : ev.start.date;
    texto += `  • ${hora} [${ev._cal}] — ${ev.summary || "Sin título"}\n`;
  });
  return texto;
}

async function eliminarEventoCalendar(eventoId, calendario) {
  const calId = encodeURIComponent(CALENDARIOS[calendario] || "primary");
  await calendarRequest("DELETE", `/calendars/${calId}/events/${eventoId}`);
  return "Evento eliminado. ✅";
}

async function moverEventoCalendar(datos) {
  const calId = encodeURIComponent(CALENDARIOS[datos.calendario] || "primary");
  await calendarRequest("DELETE", `/calendars/${calId}/events/${datos.evento_id}`);
  const fin = new Date(new Date(datos.nueva_fecha_hora).getTime() + 3600000).toISOString().slice(0, 19);
  await calendarRequest(
    "POST",
    `/calendars/${calId}/events`,
    buildEvent(datos.titulo, datos.nueva_fecha_hora, fin, null)
  );
  return `✅ Evento movido: ${datos.titulo} → ${datos.nueva_fecha_hora}`;
}

async function obtenerResumenDia() {
  const ahoraMX = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Mexico_City" }));
  const hoyStr = ahoraMX.toISOString().split("T")[0];
  const ayer = new Date(ahoraMX);
  ayer.setDate(ayer.getDate() - 1);
  const ayerStr = ayer.toISOString().split("T")[0];

  const paramsHoy = new URLSearchParams({
    timeMin: new Date(`${hoyStr}T00:00:00`).toISOString(),
    timeMax: new Date(`${hoyStr}T23:59:59`).toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
  });
  const paramsAyer = new URLSearchParams({
    timeMin: new Date(`${ayerStr}T00:00:00`).toISOString(),
    timeMax: new Date(`${ayerStr}T23:59:59`).toISOString(),
    singleEvents: "true",
  });

  const calIds = Object.entries(CALENDARIOS);

  const [hoyResults, ayerResults, tareas] = await Promise.all([
    Promise.all(calIds.map(([, id]) =>
      calendarRequest("GET", `/calendars/${encodeURIComponent(id)}/events?${paramsHoy}`)
        .then((d) => d.items || []).catch(() => [])
    )),
    Promise.all(calIds.map(([, id]) =>
      calendarRequest("GET", `/calendars/${encodeURIComponent(id)}/events?${paramsAyer}`)
        .then((d) => d.items || []).catch(() => [])
    )),
    obtenerTareas(),
  ]);

  // Fusiona y etiqueta por calendario
  const etiquetas = { personal: "Personal", solica: "Solica", visitas: "Visitas", seguimientos: "Seguimientos" };

  const eventosHoy = calIds.flatMap(([nombre], i) =>
    hoyResults[i].map((ev) => ({ ...ev, _cal: etiquetas[nombre] }))
  ).sort((a, b) => (a.start.dateTime || a.start.date) > (b.start.dateTime || b.start.date) ? 1 : -1);

  const vencidos = calIds.flatMap(([nombre], i) =>
    ayerResults[i]
      .filter((ev) => !ev.summary?.startsWith("⚠️"))
      .map((ev) => ({ ...ev, _cal: etiquetas[nombre] }))
  );

  const fechaTexto = ahoraMX.toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" });
  const hora = ahoraMX.getHours();
  const encabezado = `${hora < 12 ? "🌅 RESUMEN MATUTINO" : "🌆 RESUMEN VESPERTINO"} — ${fechaTexto}`;

  // ── Mensaje 1: Google Calendar ──
  let msgCalendar = `${encabezado}\n\n📅 GOOGLE CALENDAR\n`;

  if (vencidos.length) {
    msgCalendar += "\n⚠️ PENDIENTES DE AYER:\n";
    vencidos.forEach((ev) => (msgCalendar += `  • [${ev._cal}] ${ev.summary}\n`));
    msgCalendar += "¿Los completaste? Dime cuáles sí y cuáles reprogramamos.\n";
  }

  if (eventosHoy.length) {
    msgCalendar += "\n📌 HOY:\n";
    eventosHoy.forEach((ev) => {
      const horaEvento = ev.start.dateTime
        ? new Date(ev.start.dateTime).toLocaleTimeString("es-MX", {
            timeZone: "America/Mexico_City",
            hour: "2-digit",
            minute: "2-digit",
          })
        : "todo el día";
      msgCalendar += `  • ${horaEvento} [${ev._cal}] — ${ev.summary}\n`;
    });
  } else if (!vencidos.length) {
    msgCalendar += "\nSin eventos hoy. ✅\n";
  }

  // ── Mensaje 2: Notion ──
  const msgNotion = `📋 NOTION — TAREAS\n\n${tareas}`;

  return { calendar: msgCalendar, notion: msgNotion };
}

// ─── Escapar caracteres HTML para Telegram ───────────────────────────────────
function escaparHTML(texto) {
  return texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function enviarMensaje(chatId, texto) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: escaparHTML(texto), parse_mode: "HTML" }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error("Telegram error:", err);
    // Reintenta sin HTML si el parse falló
    if (err.description?.includes("can't parse")) {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: texto }),
      });
    }
  }
}

async function transcribirAudio(fileId) {
  try {
    const fileRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
    const fileData = await fileRes.json();
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileData.result.file_path}`;

    const audioRes = await fetch(fileUrl);
    const audioBuffer = await audioRes.arrayBuffer();

    const formData = new FormData();
    formData.append("file", new Blob([audioBuffer], { type: "audio/ogg" }), "audio.ogg");
    formData.append("model", "whisper-1");
    formData.append("language", "es");

    const whisperRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: formData,
    });

    const whisperData = await whisperRes.json();
    return whisperData.text || "[No se pudo transcribir el audio]";
  } catch (e) {
    console.error("Error transcribiendo audio:", e);
    return "[Error al procesar el audio. Por favor escribe tu mensaje.]";
  }
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
  const manana = new Date(ahora);
  manana.setDate(ahora.getDate() + 1);
  const pasado = new Date(ahora);
  pasado.setDate(ahora.getDate() + 2);

  const systemPromptConFecha =
    SYSTEM_PROMPT +
    `\n\nFECHAS DE REFERENCIA:
- Hoy: ${toISO(ahora)}
- Mañana: ${toISO(manana)}
- Pasado mañana: ${toISO(pasado)}`;

  let mensajeUsuario = texto;
  if (voz && !texto) mensajeUsuario = await transcribirAudio(voz.file_id);
  if (!mensajeUsuario) return res.status(200).json({ ok: true });

  historial.push({ role: "user", content: mensajeUsuario });
  if (historial.length > 20) historial = historial.slice(-20);

  try {
    // Agentic loop: soporta múltiples tool calls por turno y tool calls encadenadas
    const messages = [...historial];
    let finalText = "";
    let resumenEnviado = false;

    while (true) {
      const respuesta = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        system: systemPromptConFecha,
        tools,
        messages,
      });

      const toolBlocks = respuesta.content.filter((b) => b.type === "tool_use");
      const textBlocks = respuesta.content.filter((b) => b.type === "text");

      if (textBlocks.length) {
        finalText = textBlocks.map((b) => b.text).join("");
      }

      // Sin tool calls → respuesta final
      if (!toolBlocks.length) {
        messages.push({ role: "assistant", content: respuesta.content });
        break;
      }

      // Empuja turno del asistente UNA sola vez (con todos sus bloques)
      messages.push({ role: "assistant", content: respuesta.content });

      // Ejecuta todos los tools del turno y acumula resultados
      const toolResults = [];
      for (const tool of toolBlocks) {
        let resultado = "";

        if (tool.name === "guardar_en_notion") {
          await guardarEnNotion(tool.input);
          resultado = "Tarea guardada en Notion.";
        } else if (tool.name === "obtener_tareas") {
          resultado = await obtenerTareas();
        } else if (tool.name === "crear_evento_calendar") {
          resultado = await crearEventoCalendar(tool.input);
        } else if (tool.name === "obtener_eventos_calendar") {
          resultado = await obtenerEventosCalendar(tool.input.dias || 7);
        } else if (tool.name === "eliminar_evento_calendar") {
          resultado = await eliminarEventoCalendar(tool.input.evento_id, tool.input.calendario);
        } else if (tool.name === "mover_evento_calendar") {
          resultado = await moverEventoCalendar(tool.input);
        } else if (tool.name === "actualizar_tarea_notion") {
          resultado = await actualizarTareaNotion(tool.input.nombre_tarea, tool.input.nuevo_estado);
        } else if (tool.name === "buscar_evento_calendar") {
          resultado = await buscarEventoCalendar(tool.input.titulo, tool.input.dias || 14);
        } else if (tool.name === "obtener_resumen_dia") {
          const resumen = await obtenerResumenDia();
          await enviarMensaje(chatId, resumen.calendar);
          await enviarMensaje(chatId, resumen.notion);
          resultado = "[Resumen enviado]";
          resumenEnviado = true;
        }

        toolResults.push({ type: "tool_result", tool_use_id: tool.id, content: resultado });
      }

      // Todos los resultados como UN solo mensaje de usuario
      messages.push({ role: "user", content: toolResults });

      if (resumenEnviado) {
        messages.push({ role: "assistant", content: [{ type: "text", text: "Resumen enviado." }] });
        break;
      }
    }

    await redis.set(`chat:${chatId}`, messages.slice(-20), { ex: 86400 });

    if (!resumenEnviado && finalText) {
      await enviarMensaje(chatId, finalText);
    }
  } catch (error) {
    console.error("Error:", error);
    if (error?.status === 400) {
      await redis.del(`chat:${chatId}`);
      await enviarMensaje(chatId, "Reiniciando conversación. Por favor repite tu mensaje.");
    } else {
      await enviarMensaje(chatId, "Hubo un error procesando tu mensaje. Intenta de nuevo.");
    }
  }

  return res.status(200).json({ ok: true });
}
