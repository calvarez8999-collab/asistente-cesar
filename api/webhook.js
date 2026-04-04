import Anthropic from "@anthropic-ai/sdk";
import { Client as NotionClient } from "@notionhq/client";
import { Redis } from "@upstash/redis";

// ─── Clientes ───────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const notion = new NotionClient({ auth: process.env.NOTION_API_KEY });
const redis = Redis.fromEnv();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const NOTION_DB_ID = process.env.NOTION_DATABASE_ID;

// IDs de calendarios de César
const CALENDARIOS = {
  personal: "primary",
  solica: "f1ee38b2733af13f35a91c4c7350a79b3545afdb5fe06c0bd41b9e9b0fe158e8@group.calendar.google.com",
  visitas: "family08279346636537420740@group.calendar.google.com",
};

// ─── Google Calendar: OAuth2 manual (sin googleapis) ────────────────────────
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
  if (!data.access_token) {
    throw new Error("No se pudo obtener access token: " + JSON.stringify(data));
  }
  return data.access_token;
}

async function calendarRequest(method, path, body) {
  const token = await getAccessToken();
  const url = `https://www.googleapis.com/calendar/v3${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Calendar API error: ${JSON.stringify(data)}`);
  }
  return data;
}

// ─── System Prompt ───────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Eres el asistente personal de César Álvarez. Operas por Telegram.

REGLAS DE COMUNICACIÓN:
- Siempre en español, sin excepción
- Respuestas cortas y directas
- Nunca preguntes más de una cosa a la vez
- Tono cercano y claro

━━━ TIPO 1: RECORDATORIOS → Google Calendar ━━━

Son eventos con fecha Y hora específica. NO van a Notion.

César tiene 3 calendarios:
- "personal" → su calendario personal (Cesar Alvarez)
- "solica" → temas de su empresa de paneles solares
- "visitas" → citas confirmadas con clientes

FLUJO:
1. Identifica: qué, fecha, hora
2. Si falta fecha u hora → pregunta solo eso
3. Si no menciona el calendario → pregunta: "¿Lo agendo en tu calendario Personal, Solica o Visitas?"
4. Cuando tengas todos los datos, muestra confirmación:

📅 NUEVO RECORDATORIO EN CALENDAR

✅ Título: [qué]
✅ Fecha: [día y fecha]
✅ Hora: [hora]
✅ Calendario: [Personal/Solica/Visitas]
⏰ Recordatorio automático: 30 min antes
[Si es Visitas: ⏰ Recordatorio de confirmación: día anterior a las 7am o 8am]

¿Confirmas?

5. Si confirma → usa herramienta crear_evento_calendar
6. Confirma: "✅ Agendado en Google Calendar ([calendario]): [título] — [fecha] a las [hora]"

REGLA ESPECIAL PARA VISITAS — FLUJO OBLIGATORIO EN 3 PASOS:

PASO 1 — Cuando el calendario sea "visitas", ANTES de mostrar la tarjeta, pregunta:
  "¿Quieres que agregue un recordatorio de confirmación en Solica?"

PASO 2 — Con la respuesta, muestra la tarjeta de confirmación completa:

  Si dijo SÍ:
  📅 NUEVA VISITA EN CALENDAR
  ✅ Título: [qué]
  ✅ Fecha: [día y fecha]
  ✅ Hora: [hora]
  ✅ Calendario: Visitas
  ⏰ Recordatorio automático: 30 min antes
  📌 Recordatorio en Solica: [mismo día a las 9am SI la visita es a las 2pm o después / día anterior a las 4pm SI la visita es antes de las 2pm]
  ¿Confirmas?

  Si dijo NO:
  📅 NUEVA VISITA EN CALENDAR
  ✅ Título: [qué]
  ✅ Fecha: [día y fecha]
  ✅ Hora: [hora]
  ✅ Calendario: Visitas
  ⏰ Recordatorio automático: 30 min antes
  ¿Confirmas?

PASO 3 — Con confirmación, llama crear_evento_calendar UNA SOLA VEZ:
  · Respondió SÍ → omitir_recordatorio: false
  · Respondió NO → omitir_recordatorio: true
  NUNCA hagas una segunda llamada para el recordatorio — la función lo crea sola en Solica.

━━━ TIPO 2: TAREAS → Notion ━━━

Son tareas estructuradas que necesitan seguimiento. NO tienen hora exacta.

Ejemplos: "Llama al proveedor de X", "Revisar contrato con Rosa", "Preparar presentación para cliente"

CAMPOS OBLIGATORIOS PARA NOTION:
- Tarea: descripción de lo que hay que hacer
- Tipo: exactamente "Solica" o "Personal"
- Estado: exactamente "En espera", "En progreso" o "Completado" (default: En espera)
- Prioridad: exactamente "Alta", "Media" o "Baja"
- Responsable: exactamente "Cesar Alvarez" o "Rosa Ventura" (default: Cesar Alvarez)

CAMPOS OPCIONALES (NO preguntar si no los menciona):
- Fecha de inicio
- Fecha límite
- Notas

FLUJO PARA NUEVA TAREA:
1. Extrae todos los datos que mencionó César en su mensaje
2. Aplica defaults automáticos: Estado = "En espera", Responsable = "Cesar Alvarez"
3. Si Tipo NO está claro → pregunta: "¿Es de Solica o Personal?"
4. Si Prioridad NO está clara → pregunta: "¿Qué prioridad le das? Alta, Media o Baja"
5. Cuando los 5 campos obligatorios estén completos → muestra resumen y pide confirmación:

📋 NUEVA TAREA PARA NOTION

✅ Tarea: [descripción]
✅ Tipo: [Solica/Personal]
✅ Estado: En espera
✅ Prioridad: [Alta/Media/Baja]
✅ Responsable: Cesar Alvarez
⬜ Fecha límite: [si mencionó / vacío]

¿Confirmas?

6. Si César confirma → usa la herramienta guardar_en_notion
7. Confirma: "✅ Tarea guardada en Notion"

━━━ CÓMO DISTINGUIR TIPO 1 vs TIPO 2 ━━━

→ Tiene hora específica ("a las 3pm", "a las 10am") → CALENDAR
→ No tiene hora, es una tarea a completar → NOTION
→ Duda o ambiguo → pregunta: "¿Quieres que lo agende en tu calendario con hora, o lo registro como tarea en Notion?"

━━━ PALABRAS QUE SUBEN PRIORIDAD (solo para Notion) ━━━
- "urgente", "hoy", "ya", "importante", "crítico" → Prioridad: Alta

PALABRAS QUE BAJAN PRIORIDAD:
- "cuando pueda", "sin prisa", "algún día" → Prioridad: Baja

━━━ COMANDOS RÁPIDOS ━━━
- "buenos días" → saluda y pregunta si quiere ver pendientes
- "qué tengo hoy" / "mis pendientes" / "resumen" / "pendientes" → OBLIGATORIO: llama herramienta obtener_tareas SIEMPRE, nunca respondas de memoria
- "completé [tarea]" → confirma y sugiere actualizarlo en Notion
- "qué tengo en el calendario" → usa herramienta obtener_eventos_calendar

REGLA CRÍTICA: Cuando el usuario pida sus pendientes o un resumen, SIEMPRE llama obtener_tareas aunque creas recordar las tareas. NUNCA generes la lista de tareas de memoria. El resultado de la herramienta es la única fuente válida.

IMPORTANTE: Eres flexible. Si César dice la tarea con todos los datos en un mensaje
(ej: "Llamar al doctor, Solica, Alta"), extrae todo y no hagas preguntas innecesarias.`;

// ─── Herramientas (Tools) para Claude ────────────────────────────────────────
const tools = [
  {
    name: "guardar_en_notion",
    description:
      "Guarda una tarea en la base de datos Notion de César. Solo usar cuando todos los campos obligatorios estén confirmados.",
    input_schema: {
      type: "object",
      properties: {
        tarea: { type: "string", description: "Descripción de la tarea" },
        tipo: { type: "string", enum: ["Solica", "Personal"], description: "Tipo de tarea" },
        estado: {
          type: "string",
          enum: ["En espera", "En progreso", "Completado"],
          description: "Estado actual",
        },
        prioridad: {
          type: "string",
          enum: ["Alta", "Media", "Baja"],
          description: "Nivel de prioridad",
        },
        responsable: { type: "string", description: "Nombre del responsable" },
        fecha_limite: {
          type: "string",
          description: "Fecha límite en formato YYYY-MM-DD (opcional)",
        },
        notas: { type: "string", description: "Notas adicionales (opcional)" },
      },
      required: ["tarea", "tipo", "estado", "prioridad", "responsable"],
    },
  },
  {
    name: "obtener_tareas",
    description: "Obtiene las tareas pendientes de Notion para mostrar un resumen",
    input_schema: {
      type: "object",
      properties: {
        filtro: {
          type: "string",
          enum: ["todas", "alta_prioridad", "hoy"],
          description: "Qué tareas mostrar",
        },
      },
      required: ["filtro"],
    },
  },
  {
    name: "crear_evento_calendar",
    description:
      "Crea un evento o recordatorio en Google Calendar de César. Usar para cosas con fecha y hora específica (citas, juntas, llamadas agendadas).",
    input_schema: {
      type: "object",
      properties: {
        titulo: { type: "string", description: "Título del evento" },
        fecha_hora_inicio: {
          type: "string",
          description: "Fecha y hora de inicio en formato ISO 8601, ej: 2025-04-05T15:00:00",
        },
        fecha_hora_fin: {
          type: "string",
          description:
            "Fecha y hora de fin en formato ISO 8601. Si no se especifica, se asume 1 hora después del inicio.",
        },
        descripcion: {
          type: "string",
          description: "Descripción o notas del evento (opcional)",
        },
        es_todo_el_dia: {
          type: "boolean",
          description: "true si es evento de todo el día sin hora específica",
        },
        calendario: {
          type: "string",
          enum: ["personal", "solica", "visitas"],
          description:
            "Calendario donde guardar: personal=César Álvarez, solica=paneles solares, visitas=citas confirmadas con clientes",
        },
        omitir_recordatorio: {
          type: "boolean",
          description: "Solo para visitas: false=crear recordatorio en Solica, true=no crear recordatorio. OBLIGATORIO cuando calendario=visitas. La función lo crea automáticamente en Solica, NO hagas una segunda llamada.",
        },
      },
      required: ["titulo", "fecha_hora_inicio", "calendario"],
    },
  },
  {
    name: "obtener_eventos_calendar",
    description:
      "Obtiene los próximos eventos del Google Calendar de César para mostrar su agenda.",
    input_schema: {
      type: "object",
      properties: {
        dias: {
          type: "number",
          description: "Cuántos días hacia adelante consultar (por defecto 7)",
        },
      },
      required: [],
    },
  },
];

// ─── Función: Guardar en Notion ───────────────────────────────────────────────
async function guardarEnNotion(datos) {
  const properties = {
    Tarea: { title: [{ text: { content: datos.tarea } }] },
    Tipo: { select: { name: datos.tipo } },
    Estado: { status: { name: datos.estado } },
    Prioridad: { select: { name: datos.prioridad } },
    Responsable: { select: { name: datos.responsable } },
  };

  if (datos.fecha_limite) {
    properties["Fecha límite"] = { date: { start: datos.fecha_limite } };
  }
  if (datos.notas) {
    properties["Notas"] = { rich_text: [{ text: { content: datos.notas } }] };
  }

  await notion.pages.create({
    parent: { database_id: NOTION_DB_ID },
    properties,
  });
}

// ─── Función: Obtener tareas de Notion ───────────────────────────────────────
async function obtenerTareas() {
  const response = await notion.databases.query({
    database_id: NOTION_DB_ID,
    filter: {
      property: "Estado",
      status: { does_not_equal: "Completado" },
    },
    page_size: 100,
  });

  const ordenPrioridad = { Alta: 0, Media: 1, Baja: 2 };

  const tareas = response.results
    .map((page) => {
      const props = page.properties;
      const prioridadKey = Object.keys(props).find(
        (k) => k.toLowerCase() === "prioridad"
      );
      const prioridadRaw = prioridadKey ? props[prioridadKey]?.select?.name : null;
      return {
        tarea: props.Tarea?.title?.[0]?.text?.content || "Sin título",
        prioridad: prioridadRaw || "—",
        estado: props.Estado?.status?.name || props.Estado?.select?.name || "—",
        fechaLimite: props["Fecha límite"]?.date?.start || null,
      };
    })
    .sort((a, b) => (ordenPrioridad[a.prioridad] ?? 9) - (ordenPrioridad[b.prioridad] ?? 9));

  if (!tareas.length) return "No tienes pendientes activos. ✅";

  let respuesta = "📋 TUS PENDIENTES\n\n";
  const altas = tareas.filter((t) => t.prioridad === "Alta");
  const medias = tareas.filter((t) => t.prioridad === "Media");
  const bajas = tareas.filter((t) => t.prioridad === "Baja");

  if (altas.length) {
    respuesta += "🔴 URGENTE\n";
    altas.forEach(
      (t) => (respuesta += `  • ${t.tarea}${t.fechaLimite ? " — vence " + t.fechaLimite : ""}\n`)
    );
    respuesta += "\n";
  }
  if (medias.length) {
    respuesta += "🟡 MEDIA PRIORIDAD\n";
    medias.forEach((t) => (respuesta += `  • ${t.tarea}\n`));
    respuesta += "\n";
  }
  if (bajas.length) {
    respuesta += "🟢 SIN PRISA\n";
    bajas.forEach((t) => (respuesta += `  • ${t.tarea}\n`));
  }

  return respuesta;
}

// ─── Función: Crear evento en Google Calendar ────────────────────────────────
async function crearEventoCalendar(datos) {
  const calendarId = CALENDARIOS[datos.calendario] || CALENDARIOS.personal;

  const buildEvent = (titulo, inicio, fin, descripcion) => ({
    summary: titulo,
    start: { dateTime: inicio, timeZone: "America/Mexico_City" },
    end: { dateTime: fin, timeZone: "America/Mexico_City" },
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 30 }] },
    ...(descripcion ? { description: descripcion } : {}),
  });

  let event;
  if (datos.es_todo_el_dia) {
    const fechaSolo = datos.fecha_hora_inicio.split("T")[0];
    event = { summary: datos.titulo, start: { date: fechaSolo }, end: { date: fechaSolo } };
  } else {
    const inicio = datos.fecha_hora_inicio;
    const finMs = new Date(inicio).getTime() + 60 * 60 * 1000;
    const fin = datos.fecha_hora_fin || new Date(finMs).toISOString().slice(0, 19);
    event = buildEvent(datos.titulo, inicio, fin, datos.descripcion);
  }

  const encodedCalendarId = encodeURIComponent(calendarId);
  await calendarRequest("POST", `/calendars/${encodedCalendarId}/events`, event);

  // Recordatorio en Solica para visitas (solo si omitir_recordatorio === false)
  if (datos.calendario === "visitas" && !datos.es_todo_el_dia && datos.omitir_recordatorio === undefined) {
    return "ESPERA: antes de crear la visita, debes preguntarle al usuario '¿Quieres que agregue un recordatorio de confirmación en Solica?' y esperar su respuesta. Luego llama esta función con omitir_recordatorio: false (si dice sí) o omitir_recordatorio: true (si dice no).";
  }

  if (datos.calendario === "visitas" && !datos.es_todo_el_dia && datos.omitir_recordatorio === false) {
    const fechaVisita = new Date(datos.fecha_hora_inicio);
    const horaVisita = fechaVisita.getHours();

    let fechaRecordatorio;
    let horaInicio;
    let horaFin;
    let descripcionHora;

    if (horaVisita >= 14) {
      // Visita a las 2pm o después → recordatorio el mismo día a las 9am
      fechaRecordatorio = new Date(fechaVisita);
      horaInicio = "09:00:00";
      horaFin = "09:30:00";
      descripcionHora = "mismo día a las 9:00am";
    } else {
      // Visita antes de las 2pm → recordatorio el día anterior a las 4pm
      fechaRecordatorio = new Date(fechaVisita);
      fechaRecordatorio.setDate(fechaRecordatorio.getDate() - 1);
      horaInicio = "16:00:00";
      horaFin = "16:30:00";
      descripcionHora = "día anterior a las 4:00pm";
    }

    const fechaStr = fechaRecordatorio.toISOString().split("T")[0];

    const eventoRecordatorio = buildEvent(
      `⚠️ Confirmar visita: ${datos.titulo}`,
      `${fechaStr}T${horaInicio}`,
      `${fechaStr}T${horaFin}`,
      "Reconfirmar cita del día"
    );

    await calendarRequest(
      "POST",
      `/calendars/${encodeURIComponent(CALENDARIOS.solica)}/events`,
      eventoRecordatorio
    );

    return `✅ Visita agendada: ${datos.titulo}\n📌 Recordatorio en Solica: ${descripcionHora}`;
  }

  return `✅ Evento creado en ${datos.calendario}: ${datos.titulo}`;
}

// ─── Función: Obtener eventos de Google Calendar ─────────────────────────────
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

  const data = await calendarRequest("GET", `/calendars/primary/events?${params}`);
  const eventos = data.items || [];

  if (!eventos.length) return `No tienes eventos en los próximos ${dias} días. 📅`;

  let respuesta = `📅 TU AGENDA (próximos ${dias} días)\n\n`;

  for (const ev of eventos) {
    const inicio = ev.start.dateTime
      ? new Date(ev.start.dateTime).toLocaleString("es-MX", {
          timeZone: "America/Mexico_City",
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : ev.start.date;

    respuesta += `  • ${ev.summary || "Sin título"} — ${inicio}\n`;
  }

  return respuesta;
}

// ─── Función: Enviar mensaje a Telegram ──────────────────────────────────────
async function enviarMensaje(chatId, texto) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: texto,
      parse_mode: "HTML",
    }),
  });
}

// ─── Función: Procesar herramienta ────────────────────────────────────────────
async function procesarHerramienta(bloque) {
  if (bloque.name === "guardar_en_notion") {
    await guardarEnNotion(bloque.input);
    return "Tarea guardada exitosamente en Notion.";
  } else if (bloque.name === "obtener_tareas") {
    return await obtenerTareas();
  } else if (bloque.name === "crear_evento_calendar") {
    return await crearEventoCalendar(bloque.input);
  } else if (bloque.name === "obtener_eventos_calendar") {
    return await obtenerEventosCalendar(bloque.input.dias || 7);
  }
  return "Herramienta no reconocida.";
}

// ─── Handler principal ───────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true });
  }

  const { message } = req.body;
  if (!message) return res.status(200).json({ ok: true });

  const chatId = message.chat.id;
  const texto = message.text || "";

  if (!texto) return res.status(200).json({ ok: true });

  // Obtener historial de conversación
  let historial = (await redis.get(`chat:${chatId}`)) || [];

  // Fecha actual para contexto (zona horaria México)
  const ahora = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Mexico_City" }));
  const toISO = (d) => d.toISOString().split("T")[0];
  const manana = new Date(ahora);
  manana.setDate(ahora.getDate() + 1);
  const pasado = new Date(ahora);
  pasado.setDate(ahora.getDate() + 2);
  const systemPromptConFecha =
    SYSTEM_PROMPT +
    `\n\nFECHAS DE REFERENCIA (usar exactamente estas):
- Hoy: ${toISO(ahora)}
- Mañana: ${toISO(manana)}
- Pasado mañana: ${toISO(pasado)}
Cuando el usuario diga "hoy", "mañana", "esta semana", usa estas fechas ISO exactas.`;

  // Agregar mensaje del usuario al historial
  historial.push({ role: "user", content: texto });
  if (historial.length > 20) historial = historial.slice(-20);

  try {
    // Llamar a Claude — agentic loop
    let mensajes = [...historial];
    let textoRespuesta = "";

    while (true) {
      const respuesta = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        system: systemPromptConFecha,
        tools,
        messages: mensajes,
      });

      // Agregar respuesta del asistente al loop
      mensajes.push({ role: "assistant", content: respuesta.content });

      const toolUseBlocks = respuesta.content.filter((b) => b.type === "tool_use");
      const textBlocks = respuesta.content.filter((b) => b.type === "text");

      if (textBlocks.length > 0) {
        textoRespuesta = textBlocks.map((b) => b.text).join("");
      }

      // Si no hay tool_use, terminamos
      if (toolUseBlocks.length === 0) break;

      // Ejecutar todas las herramientas y agregar resultados
      const toolResults = [];
      for (const bloque of toolUseBlocks) {
        const resultado = await procesarHerramienta(bloque);
        toolResults.push({
          type: "tool_result",
          tool_use_id: bloque.id,
          content: resultado,
        });
      }

      mensajes.push({ role: "user", content: toolResults });
    }

    // Guardar historial actualizado (últimos 20 mensajes)
    historial = mensajes.slice(-20);
    await redis.set(`chat:${chatId}`, historial, { ex: 86400 });

    // Enviar respuesta a Telegram
    if (textoRespuesta) {
      await enviarMensaje(chatId, textoRespuesta);
    }
  } catch (error) {
    console.error("Error:", error);
    if (error?.status === 400 && error?.message?.includes("tool_use")) {
      await redis.del(`chat:${chatId}`);
      await enviarMensaje(chatId, "Reiniciando conversación. Por favor repite tu mensaje.");
    } else {
      await enviarMensaje(chatId, `Hubo un error: ${error.message?.slice(0, 200) || "intenta de nuevo"}`);
    }
  }

  return res.status(200).json({ ok: true });
}
