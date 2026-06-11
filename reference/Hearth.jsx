import { useState, useEffect, useRef, useCallback } from "react";
import {
  Sun, CloudSun, Cloud, CloudFog, CloudDrizzle, CloudRain, CloudSnow,
  CloudLightning, Wind, Droplets, MapPin, CalendarDays, StickyNote,
  Clapperboard, Film, Tv, Images, HardDrive, ArrowUpRight, Check, Loader,
} from "lucide-react";

/* ───────────────────────────────────────────────────────────
   CONFIG  —  maps 1:1 onto the future hearth.yaml.
   statServices each correspond to one proxy adapter (/api/<key>).
   Add a service to the dashboard = one entry here + one adapter file.
─────────────────────────────────────────────────────────── */
const CONFIG = {
  name: "Miles",
  location: { name: "Port Seton", latitude: 55.969, longitude: -2.949 },
  statsBase: "http://hearth-proxy.local:8787/api",
  statServices: [
    {
      key: "jellyfin", label: "Jellyfin", url: "http://jellyfin.local:8096",
      accent: "#a584ff", Icon: Clapperboard,
      demo: { status: "demo", stats: [
        { key: "movies", label: "Films", value: 1248, format: "number" },
        { key: "size", label: "Library", value: 5.17e12, format: "bytes" },
        { key: "latest", label: "Latest", value: "Dune: Part Two (2024)", format: "text", meta: new Date(Date.now() - 3 * 864e5).toISOString() },
      ] },
    },
    {
      key: "radarr", label: "Radarr", url: "http://radarr.local:7878",
      accent: "#ffc230", Icon: Film,
      demo: { status: "demo", stats: [
        { key: "movies", label: "Movies", value: 1310, format: "number" },
        { key: "queue", label: "Queue", value: 3, format: "number" },
      ] },
    },
    {
      key: "sonarr", label: "Sonarr", url: "http://sonarr.local:8989",
      accent: "#3bc16b", Icon: Tv,
      demo: { status: "demo", stats: [
        { key: "series", label: "Series", value: 84, format: "number" },
        { key: "queue", label: "Queue", value: 1, format: "number" },
      ] },
    },
  ],
  links: [
    { key: "immich", name: "Immich", blurb: "Photos & backups", url: "http://immich.local:2283", Icon: Images, accent: "#fa5b6b" },
    { key: "synology", name: "Synology NAS", blurb: "DS216 · storage", url: "http://nas.local:5000", Icon: HardDrive, accent: "#4f9be8" },
  ],
};

/* WMO weather code → label + icon */
function wx(code) {
  if (code === 0) return { label: "Clear", Icon: Sun };
  if (code === 1 || code === 2) return { label: "Partly cloudy", Icon: CloudSun };
  if (code === 3) return { label: "Overcast", Icon: Cloud };
  if (code === 45 || code === 48) return { label: "Fog", Icon: CloudFog };
  if (code >= 51 && code <= 57) return { label: "Drizzle", Icon: CloudDrizzle };
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return { label: "Rain", Icon: CloudRain };
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { label: "Snow", Icon: CloudSnow };
  if (code >= 95) return { label: "Thunderstorm", Icon: CloudLightning };
  return { label: "—", Icon: Cloud };
}

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const fmtSize = (b) => {
  if (!b) return "0";
  const tb = b / 1e12;
  if (tb >= 1) return `${tb.toFixed(tb >= 10 ? 0 : 1)} TB`;
  const gb = b / 1e9;
  if (gb >= 1) return `${Math.round(gb)} GB`;
  return `${Math.round(b / 1e6)} MB`;
};
const rel = (iso) => {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
const fmtVal = (s) => {
  switch (s.format) {
    case "bytes": return fmtSize(s.value);
    case "speed": return `${fmtSize(s.value)}/s`;
    case "percent": return `${Math.round(s.value)}%`;
    case "number": return Number(s.value).toLocaleString();
    default: return String(s.value);
  }
};
const metaText = (m) => (/\d{4}-\d{2}-\d{2}T/.test(m) ? rel(m) : m);

/* generic, config-driven service stats card */
function ServiceCard({ svc, delay }) {
  const [s, setS] = useState({ state: "loading" });
  useEffect(() => {
    let alive = true;
    fetch(`${CONFIG.statsBase}/${svc.key}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => { if (alive) { if (d.error || !d.stats) throw 0; setS({ state: "live", data: d }); } })
      .catch(() => { if (alive) setS(svc.demo ? { state: "demo", data: svc.demo } : { state: "error" }); });
    return () => { alive = false; };
  }, []);

  return (
    <section className="card svc-card reveal" style={{ "--d": `${delay}ms`, "--c": svc.accent }}>
      <div className="card-h">
        <span className="card-t"><svc.Icon size={15} /> {svc.label}</span>
        <a className="card-link" href={svc.url} target="_blank" rel="noreferrer"><ArrowUpRight size={15} /></a>
      </div>
      {s.state === "loading" && <div className="centre muted"><Loader size={16} className="spin" /> Loading…</div>}
      {s.state === "error" && <div className="centre muted">Unavailable</div>}
      {(s.state === "live" || s.state === "demo") && (() => {
        const [hero, ...rest] = s.data.stats;
        return (
          <>
            <div className="sv-hero">
              <span className="sv-big">{fmtVal(hero)}</span>
              <span className="sv-unit">{hero.label}</span>
            </div>
            {rest.length > 0 && (
              <div className="sv-rows">
                {rest.map((st) => (
                  <div className="sv-row" key={st.key}>
                    <span className="sv-k">{st.label}</span>
                    <span className="sv-right">
                      <span className="sv-v">{fmtVal(st)}</span>
                      {st.meta && <span className="sv-meta">{metaText(st.meta)}</span>}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {s.state === "demo" && <span className="demo">demo · start the proxy for live data</span>}
          </>
        );
      })()}
    </section>
  );
}

export default function Hearth() {
  const [now, setNow] = useState(new Date());
  const [weather, setWeather] = useState({ state: "loading" });
  const [notes, setNotes] = useState("");
  const [saved, setSaved] = useState(true);
  const saveTimer = useRef(null);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const { latitude, longitude } = CONFIG.location;
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
      `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=5&wind_speed_unit=mph`;
    fetch(url).then((r) => (r.ok ? r.json() : Promise.reject())).then((d) => setWeather({ state: "ok", data: d })).catch(() => setWeather({ state: "error" }));
  }, []);

  useEffect(() => {
    (async () => { try { const res = await window.storage?.get("hearth:notes"); if (res?.value) setNotes(res.value); } catch { /* none */ } })();
  }, []);
  const onNotes = useCallback((v) => {
    setNotes(v); setSaved(false);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => { try { await window.storage?.set("hearth:notes", v); } catch { /* mem */ } setSaved(true); }, 600);
  }, []);

  const hour = now.getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const timeStr = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const dateStr = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });

  const y = now.getFullYear(), m = now.getMonth();
  const firstDow = (new Date(y, m, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  return (
    <div className="hearth">
      <style>{CSS}</style>
      <div className="glow" />
      <div className="shell">

        <header className="head reveal" style={{ "--d": "0ms" }}>
          <div>
            <h1 className="greet">{greeting}, {CONFIG.name}.</h1>
            <p className="sub">{dateStr}</p>
          </div>
          <div className="clock">
            <span className="time">{timeStr}</span>
            <span className="loc"><MapPin size={13} /> {CONFIG.location.name}</span>
          </div>
        </header>

        <div className="grid">

          {/* WEATHER */}
          <section className="card weather reveal" style={{ "--d": "70ms" }}>
            <div className="card-h"><span className="card-t">Weather</span><span className="card-x">{CONFIG.location.name}</span></div>
            {weather.state === "loading" && <div className="centre muted"><Loader size={18} className="spin" /> Fetching forecast…</div>}
            {weather.state === "error" && <div className="centre muted">Couldn’t reach the weather service.</div>}
            {weather.state === "ok" && (() => {
              const c = weather.data.current, dy = weather.data.daily, cur = wx(c.weather_code);
              return (
                <>
                  <div className="wx-now">
                    <cur.Icon size={64} strokeWidth={1.4} className="wx-ico" />
                    <div className="wx-temp"><span className="big">{Math.round(c.temperature_2m)}°</span><span className="cond">{cur.label}</span></div>
                    <div className="wx-meta">
                      <span>Feels {Math.round(c.apparent_temperature)}°</span>
                      <span><Droplets size={13} /> {c.relative_humidity_2m}%</span>
                      <span><Wind size={13} /> {Math.round(c.wind_speed_10m)} mph</span>
                    </div>
                  </div>
                  <div className="wx-week">
                    {dy.time.map((iso, i) => {
                      const w = wx(dy.weather_code[i]);
                      const lbl = i === 0 ? "Today" : DOW[(new Date(iso).getDay() + 6) % 7];
                      return (
                        <div className="wx-day" key={iso}>
                          <span className="wx-dow">{lbl}</span>
                          <w.Icon size={22} strokeWidth={1.6} />
                          <span className="wx-hl">{Math.round(dy.temperature_2m_max[i])}°<em>{Math.round(dy.temperature_2m_min[i])}°</em></span>
                        </div>
                      );
                    })}
                  </div>
                </>
              );
            })()}
          </section>

          {/* CALENDAR */}
          <section className="card cal reveal" style={{ "--d": "140ms" }}>
            <div className="card-h"><span className="card-t"><CalendarDays size={15} /> Calendar</span><span className="card-x">{now.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</span></div>
            <div className="cal-grid cal-dow">{DOW.map((d) => <span key={d} className="cal-dowt">{d}</span>)}</div>
            <div className="cal-grid">
              {cells.map((d, i) => (
                <span key={i} className={"cal-cell" + (d === now.getDate() ? " today" : "") + (d === null ? " empty" : "")}>{d || ""}</span>
              ))}
            </div>
          </section>

          {/* SERVICE STATS (generic, config-driven) */}
          {CONFIG.statServices.map((svc, i) => (
            <ServiceCard key={svc.key} svc={svc} delay={210 + i * 70} />
          ))}

          {/* NOTES */}
          <section className="card notes reveal" style={{ "--d": "420ms" }}>
            <div className="card-h"><span className="card-t"><StickyNote size={15} /> Notes</span><span className={"save " + (saved ? "ok" : "")}>{saved ? <><Check size={12} /> Saved</> : "Saving…"}</span></div>
            <textarea className="notes-area" value={notes} onChange={(e) => onNotes(e.target.value)} placeholder="Jot something down — it persists across reloads." spellCheck={false} />
          </section>

          {/* NETWORK LINKS */}
          <section className="card net reveal" style={{ "--d": "490ms" }}>
            <div className="card-h"><span className="card-t">Network</span><span className="card-x">{CONFIG.links.length} links</span></div>
            <div className="net-list">
              {CONFIG.links.map((s) => (
                <a key={s.key} href={s.url} target="_blank" rel="noreferrer" className="svc" style={{ "--c": s.accent }}>
                  <span className="svc-ico"><s.Icon size={20} strokeWidth={1.7} /></span>
                  <span className="svc-body"><span className="svc-name">{s.name}</span><span className="svc-blurb">{s.blurb}</span></span>
                  <ArrowUpRight size={15} className="svc-go" />
                </a>
              ))}
            </div>
          </section>

        </div>

        <footer className="foot reveal" style={{ "--d": "560ms" }}>Hearth · self-hosted home dashboard</footer>
      </div>
    </div>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400..600;1,9..144,400&family=Hanken+Grotesk:wght@400;500;600;700&display=swap');

.hearth{
  --bg:#16110e; --ink:#f6ece2; --muted:#b6a596; --faint:#8a796c;
  --line:rgba(255,255,255,.085); --card:rgba(255,255,255,.035); --card-h:rgba(255,255,255,.06);
  --ember:#f0793b; --ember2:#f4a65b; --ember-deep:#cf5523;
  position:relative; min-height:100vh; width:100%;
  background:radial-gradient(120% 90% at 8% -10%, #251a13 0%, var(--bg) 46%, #120d0a 100%);
  color:var(--ink); font-family:'Hanken Grotesk',system-ui,sans-serif; -webkit-font-smoothing:antialiased; overflow-x:hidden;
}
.hearth::before{content:''; position:fixed; inset:0; pointer-events:none; opacity:.045; z-index:0;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");}
.glow{position:fixed; top:-22%; left:-8%; width:60vw; height:60vw; max-width:760px; max-height:760px;
  background:radial-gradient(circle, rgba(240,121,59,.20) 0%, rgba(240,121,59,0) 62%); filter:blur(20px); pointer-events:none; z-index:0; animation:breathe 9s ease-in-out infinite;}
@keyframes breathe{0%,100%{opacity:.75;transform:scale(1)}50%{opacity:1;transform:scale(1.06)}}

.shell{position:relative; z-index:1; max-width:1140px; margin:0 auto; padding:clamp(20px,4vw,46px);}
.head{display:flex; justify-content:space-between; align-items:flex-end; gap:20px; margin-bottom:30px; flex-wrap:wrap;}
.greet{font-family:'Fraunces',serif; font-weight:500; font-size:clamp(1.9rem,4.4vw,3rem); line-height:1.04; letter-spacing:-.01em; margin:0;}
.sub{margin:.5rem 0 0; color:var(--muted); font-size:.98rem;}
.clock{display:flex; flex-direction:column; align-items:flex-end; gap:.25rem;}
.time{font-family:'Fraunces',serif; font-size:clamp(1.6rem,3vw,2.1rem); font-weight:500; font-variant-numeric:tabular-nums;}
.loc{display:flex; align-items:center; gap:5px; color:var(--faint); font-size:.84rem; text-transform:uppercase; letter-spacing:.08em;}

.grid{display:grid; grid-template-columns:repeat(12,1fr); gap:16px;}
.weather{grid-column:span 8;}
.cal{grid-column:span 4;}
.svc-card{grid-column:span 4;}
.notes{grid-column:span 4;}
.net{grid-column:span 4;}

.card{background:var(--card); border:1px solid var(--line); border-radius:20px; padding:20px 22px; backdrop-filter:blur(8px); transition:border-color .25s ease, transform .25s ease, background .25s ease;}
.card:hover{border-color:var(--card-h); background:var(--card-h);}
.card-h{display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;}
.card-t{display:flex; align-items:center; gap:7px; font-size:.74rem; font-weight:600; text-transform:uppercase; letter-spacing:.14em; color:var(--muted);}
.svc-card .card-t svg{color:var(--c);}
.card-x{font-size:.78rem; color:var(--faint);}
.card-link{color:var(--faint); transition:color .2s, transform .2s; display:flex;}
.card-link:hover{color:var(--c,var(--ember2)); transform:translate(2px,-2px);}
.centre{display:flex; align-items:center; justify-content:center; gap:8px; min-height:120px;}
.muted{color:var(--muted); font-size:.92rem;}
.spin{animation:spin 1s linear infinite;}
@keyframes spin{to{transform:rotate(360deg)}}

.wx-now{display:flex; align-items:center; gap:18px; flex-wrap:wrap;}
.wx-ico{color:var(--ember2); filter:drop-shadow(0 4px 14px rgba(240,121,59,.35)); flex:none;}
.wx-temp{display:flex; flex-direction:column;}
.wx-temp .big{font-family:'Fraunces',serif; font-size:3.4rem; line-height:.92; font-weight:500;}
.wx-temp .cond{color:var(--muted); margin-top:.3rem;}
.wx-meta{margin-left:auto; display:flex; flex-direction:column; gap:.4rem; color:var(--faint); font-size:.86rem;}
.wx-meta span{display:flex; align-items:center; gap:6px; justify-content:flex-end;}
.wx-week{display:grid; grid-template-columns:repeat(5,1fr); gap:8px; margin-top:20px; padding-top:18px; border-top:1px solid var(--line);}
.wx-day{display:flex; flex-direction:column; align-items:center; gap:7px;}
.wx-dow{font-size:.74rem; color:var(--faint); text-transform:uppercase; letter-spacing:.05em;}
.wx-day svg{color:var(--muted);}
.wx-hl{font-size:.86rem; font-variant-numeric:tabular-nums;}
.wx-hl em{color:var(--faint); font-style:normal; margin-left:5px;}

.cal-grid{display:grid; grid-template-columns:repeat(7,1fr); gap:3px;}
.cal-dow{margin-bottom:6px;}
.cal-dowt{text-align:center; font-size:.68rem; color:var(--faint); text-transform:uppercase; letter-spacing:.04em;}
.cal-cell{display:flex; align-items:center; justify-content:center; aspect-ratio:1; font-size:.84rem; border-radius:9px; font-variant-numeric:tabular-nums;}
.cal-cell.empty{color:transparent;}
.cal-cell.today{background:linear-gradient(145deg,var(--ember),var(--ember-deep)); color:#fff; font-weight:600; box-shadow:0 5px 16px rgba(207,85,35,.4);}

/* generic service stat card */
.sv-hero{display:flex; flex-direction:column; gap:2px; padding:2px 0 14px;}
.sv-big{font-family:'Fraunces',serif; font-size:2.7rem; line-height:1; font-weight:500;}
.sv-unit{color:var(--muted); font-size:.85rem;}
.sv-rows{display:flex; flex-direction:column; gap:11px; border-top:1px solid var(--line); padding-top:13px;}
.sv-row{display:flex; justify-content:space-between; align-items:baseline; gap:10px;}
.sv-k{color:var(--faint); font-size:.8rem; flex:none;}
.sv-right{display:flex; flex-direction:column; align-items:flex-end; min-width:0;}
.sv-v{font-weight:600; font-size:.9rem; max-width:170px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.sv-meta{font-size:.7rem; color:var(--faint);}
.demo{display:inline-block; margin-top:13px; font-size:.7rem; color:var(--c,var(--ember2)); background:color-mix(in srgb, var(--c,var(--ember)) 14%, transparent); padding:3px 9px; border-radius:99px;}

.notes{display:flex; flex-direction:column;}
.save{display:flex; align-items:center; gap:5px; font-size:.74rem; color:var(--faint); transition:color .2s;}
.save.ok{color:#7fbf8f;}
.notes-area{flex:1; min-height:120px; resize:none; width:100%; background:transparent; border:none; outline:none; color:var(--ink); font-family:'Hanken Grotesk',sans-serif; font-size:.95rem; line-height:1.6;}
.notes-area::placeholder{color:var(--faint);}

.net-list{display:flex; flex-direction:column; gap:10px;}
.svc{display:flex; align-items:center; gap:13px; padding:14px; border-radius:14px; background:rgba(255,255,255,.03); border:1px solid var(--line); text-decoration:none; color:var(--ink); position:relative; overflow:hidden; transition:transform .2s ease, border-color .2s ease;}
.svc::after{content:''; position:absolute; inset:0; background:radial-gradient(120% 140% at 0% 0%, color-mix(in srgb, var(--c) 16%, transparent) 0%, transparent 60%); opacity:0; transition:opacity .25s;}
.svc:hover{transform:translateY(-2px); border-color:color-mix(in srgb, var(--c) 45%, transparent);}
.svc:hover::after{opacity:1;}
.svc-ico{display:flex; align-items:center; justify-content:center; width:40px; height:40px; flex:none; border-radius:11px; color:var(--c); background:color-mix(in srgb, var(--c) 15%, transparent); position:relative; z-index:1;}
.svc-body{display:flex; flex-direction:column; min-width:0; position:relative; z-index:1;}
.svc-name{font-weight:600; font-size:.95rem;}
.svc-blurb{font-size:.78rem; color:var(--faint); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}
.svc-go{margin-left:auto; color:var(--faint); flex:none; position:relative; z-index:1; transition:color .2s, transform .2s;}
.svc:hover .svc-go{color:var(--c); transform:translate(2px,-2px);}

.foot{margin-top:30px; text-align:center; color:var(--faint); font-size:.78rem; letter-spacing:.04em;}
.reveal{opacity:0; transform:translateY(14px); animation:rise .7s cubic-bezier(.2,.7,.2,1) forwards; animation-delay:var(--d);}
@keyframes rise{to{opacity:1; transform:none;}}

@media(max-width:900px){
  .weather,.cal,.svc-card,.notes,.net{grid-column:span 12;}
  .weather{order:1;} .svc-card{order:2;} .net{order:3;} .cal{order:4;} .notes{order:5;}
  .wx-meta{margin-left:0; flex-direction:row; gap:14px; width:100%; margin-top:10px;}
  .wx-meta span{justify-content:flex-start;}
}
`;
