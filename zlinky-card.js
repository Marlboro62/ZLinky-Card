/**
 * zlinky-card — « Carte ZLinky »
 *
 * Consommation du compteur Linky lue en direct par un LiXee ZLinky (Zigbee : ZHA ou Zigbee2MQTT),
 * d'après les statistiques de Home Assistant. Même présentation que la carte Enedis Linky New
 * (Marlboro62/content-card-linky-new), sans MyElectricalData ni Enedis.
 *
 * type: custom:zlinky-card
 * hc_entity: sensor.<index heures creuses>
 * hp_entity: sensor.<index heures pleines>      (ou base_entity: sensor.<index base>)
 * power_entity: sensor.<puissance apparente>     (facultatif)
 *
 * Prix : ceux du tableau Énergie de Home Assistant ; ceux saisis dans la carte (hc_price, hp_price, base_price) passent avant.
 *
 * © 2026 Marlboro62.
 */
(() => {
const CARD_VERSION = "0.1.3";

/* ---------------------------------------------------------------- données */

const MED = {
  /** "a,b,c" ou [a,b,c] -> tableau ; "-1" / -1 / "" -> null */
  list(value, kind = "num") {
    if (value === undefined || value === null) return [];
    const raw = Array.isArray(value) ? value : String(value).split(",");
    return raw.map((v) => {
      const s = String(v).trim();
      if (s === "" || s === "-1" || s === "null") return null;
      if (kind === "num") {
        const n = Number(s);
        return Number.isFinite(n) ? n : null;
      }
      if (kind === "bool") return s === "true";
      return s;
    });
  },

  /** "2026-10-05" -> date locale (new Date() la lirait en UTC) */
  date(value) {
    if (!value) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  },

  num(value) {
    if (value === undefined || value === null || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) && n !== -1 ? n : null;
  },

  /** Construit la série des jours, du plus récent au plus ancien. */
  days(attr) {
    const dates = MED.list(attr.dailyweek, "str");
    const total = MED.list(attr.daily);
    const hc = MED.list(attr.dailyweek_HC);
    const hp = MED.list(attr.dailyweek_HP);
    const mp = MED.list(attr.dailyweek_MP);
    const mpTime = MED.list(attr.dailyweek_MP_time, "str");
    const mpOver = MED.list(attr.dailyweek_MP_over, "bool");
    const tempo = MED.list(attr.dailyweek_Tempo, "str");
    // Coût du jour calculé par MyElectricalData avec l'offre choisie sur le PDL (-1 : pas de prix HC/HP, ex. Tempo)
    const cost = MED.list(attr.dailyweek_cost);
    return dates.map((d, i) => {
      const h = hc[i] ?? null;
      const p = hp[i] ?? null;
      let t = total[i] ?? null;
      if (t === null && h !== null && p !== null) t = h + p;
      return {
        date: MED.date(d),
        total: t,
        hc: h,
        hp: p,
        mp: mp[i] ?? null,
        mpTime: MED.date(mpTime[i]),
        mpOver: mpOver[i] === true,
        tempo: tempo[i] ? tempo[i].toLowerCase() : null,
        offerCost: cost[i] ?? null,
      };
    });
  },

  /** Coût d'un jour à partir des prix Tempo publiés par MyElectricalData. */
  cost(day, prices) {
    if (!prices || day.hc === null || day.hp === null || !day.tempo) return null;
    const p = prices[day.tempo];
    if (!p || p.hc === null || p.hp === null) return null;
    return day.hc * p.hc + day.hp * p.hp;
  },

  /** Répartition HC/HP estimée d'un jour sans détail, d'après la part HP habituelle. */
  estimate(day, hpPct) {
    if (day.total === null || hpPct === null || hpPct < 0 || hpPct > 100) return null;
    const hp = (day.total * hpPct) / 100;
    return { hc: day.total - hp, hp };
  },

  /** Jours Tempo restants : quota - used (le champ remaining de MyElectricalData n'est pas fiable). */
  tempoLeft(info) {
    if (!info) return null;
    const out = {};
    for (const c of ["blue", "white", "red"]) {
      const d = info[`days_${c}_detail`];
      if (d && Number.isFinite(d.quota) && Number.isFinite(d.used)) {
        out[c] = { left: Math.max(0, d.quota - d.used), quota: d.quota };
      }
    }
    return Object.keys(out).length ? out : null;
  },
};

/* ------------------------------------------------------------- affichage */

const fmt = (n, digits = 1) =>
  n === null || n === undefined
    ? "—"
    : Number(n).toLocaleString("fr-FR", { minimumFractionDigits: digits, maximumFractionDigits: digits });

const euro = (n) =>
  n === null || n === undefined
    ? "—"
    : Number(n).toLocaleString("fr-FR", { style: "currency", currency: "EUR" });

const TEMPO = {
  blue: { label: "Bleu", cls: "t-blue" },
  white: { label: "Blanc", cls: "t-white" },
  red: { label: "Rouge", cls: "t-red" },
};

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** Couleur choisie (hc_color, hp_color) : "#1e88e5", [r, g, b], rgb()/hsl(), var(--x) ou nom CSS.
 *  null si absente ou invalide (la couleur par défaut s'applique). */
const cssColor = (value) => {
  if (Array.isArray(value)) {
    const n = value.map(Number);
    return n.length === 3 && n.every(Number.isFinite) ? `rgb(${n.map((v) => Math.max(0, Math.min(255, Math.round(v)))).join(", ")})` : null;
  }
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) return v;
  if (/^(rgba?|hsla?)\([\d\s.,%/]+\)$/i.test(v) || /^var\(--[\w-]+\)$/.test(v) || /^[a-z]{3,20}$/i.test(v)) return v;
  return null;
};

/** Prix du kWh saisis dans la carte (hc_price + hp_price, ou base_price), en €/kWh ; null si non renseignés. */
const positivePrice = (v) => {
  const x = Number(typeof v === "string" ? v.replace(",", ".") : v);
  return Number.isFinite(x) && x > 0 ? x : null;
};
const manualPrices = (c) => {
  const n = positivePrice;
  const hc = n(c.hc_price), hp = n(c.hp_price), base = n(c.base_price);
  if (hc !== null && hp !== null) return { hc, hp, base };
  return base !== null ? { hc: null, hp: null, base } : null;
};
/** Coût d'un jour avec les prix saisis : HC et HP si connus, sinon prix Base sur le total. */
const manualCost = (d, p) => {
  if (p.hc !== null && d.hc !== null && d.hp !== null) return d.hc * p.hc + d.hp * p.hp;
  if (p.base !== null && d.total !== null) return d.total * p.base;
  return null;
};

/** Couleurs Tempo pour lesquelles on peut choisir des couleurs HC / HP propres (hc_blue_color … hp_red_color). */
const TEMPO_KEYS = ["blue", "white", "red"];
const hasTempoColors = (c) => TEMPO_KEYS.some((t) => cssColor(c[`hc_${t}_color`]) || cssColor(c[`hp_${t}_color`]));

/** Style à poser sur ha-card pour les couleurs HC / HP personnalisées (générales, puis par couleur Tempo).
 *  Le texte du détail mélange la couleur choisie avec celle du texte de la carte : même teinte,
 *  mais lisible même si la couleur est foncée. */
const hcHpStyle = (c) => {
  const vars = [];
  for (const t of ["", ...TEMPO_KEYS]) {
    for (const k of ["hc", "hp"]) {
      const col = cssColor(c[t ? `${k}_${t}_color` : `${k}_color`]);
      const v = t ? `--med-${k}-${t}` : `--med-${k}`;
      if (col) vars.push(`${v}: ${col}; ${v}-text: color-mix(in srgb, ${col} 65%, var(--med-text));`);
    }
  }
  const base = cssColor(c.base_color);
  if (base) vars.push(`--med-base: ${base};`);
  // Taille de la police : facteur appliqué à toutes les tailles en rem de la carte (100 % = taille d'origine)
  const fs = Number(c.font_size);
  if (Number.isFinite(fs) && fs >= 50 && fs <= 200 && fs !== 100) vars.push(`--fs: ${fs / 100};`);
  return vars.length ? ` style="${esc(vars.join(" "))}"` : "";
};

/** Conversions pour la roue de couleurs de l'éditeur (teinte 0-360, saturation et luminosité 0-1). */
const hsvToHex = (h, sat, val) => {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * (val - val * sat * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return "#" + [f(5), f(3), f(1)].map((x) => x.toString(16).padStart(2, "0")).join("");
};
const hexToHsv = (hex) => {
  let m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m && /^#?([0-9a-f]{3})$/i.test(hex || "")) m = [0, hex.replace("#", "").split("").map((x) => x + x).join("")];
  if (!m) return null;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
};
/** "#1e88e5", [r, g, b] ou "rgb(...)" -> "#rrggbb" (pour la roue), sinon null */
const toHex = (value) => {
  const col = cssColor(value);
  if (!col) return null;
  if (/^#[0-9a-f]{6}$/i.test(col)) return col.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(col)) return ("#" + col.slice(1).split("").map((x) => x + x).join("")).toLowerCase();
  const m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(col);
  return m ? "#" + m.slice(1, 4).map((x) => Math.min(255, Number(x)).toString(16).padStart(2, "0")).join("") : null;
};

/** Le capteur des jours Tempo restants porte l'un de ces deux noms selon l'installation :
 *  celui de la configuration d'abord, puis les deux noms connus. */
const TEMPO_INFO_IDS = (configured) =>
  [...new Set([configured, "sensor.edf_tempo_info", "sensor.edf_tempo_tempo_info", "sensor.myelectricaldata_tempo_info"].filter(Boolean))];

/** Noms possibles des entités de l'export Home Assistant : Home Assistant les nomme d'après l'appareil
 *  (sensor.rte_tempo_today) ou, depuis 2025.10, d'après l'identifiant suggéré (sensor.myelectricaldata_tempo_today). */
const ENTITY_ALIASES = {
  tempo_today: ["sensor.rte_tempo_today", "sensor.myelectricaldata_tempo_today"],
  tempo_tomorrow: ["sensor.rte_tempo_tomorrow", "sensor.myelectricaldata_tempo_tomorrow"],
  ecowatt: ["sensor.rte_ecowatt_j0", "sensor.myelectricaldata_ecowatt_j0"],
};
const PRICE_PREFIXES = ["sensor.edf_tempo_price_", "sensor.myelectricaldata_tempo_price_"];

/** Remplace une entité introuvable par son autre nom, s'il existe. L'éditeur visuel enregistre aussi les valeurs
 *  par défaut : seule l'existence de l'entité compte, une entité choisie qui existe n'est jamais remplacée. */
const withAliases = (config, hass) => {
  const states = hass?.states || {};
  const out = { ...config };
  for (const [key, ids] of Object.entries(ENTITY_ALIASES)) {
    if (key in out && !states[out[key]]) out[key] = ids.find((id) => states[id]) || out[key];
  }
  if ("price_prefix" in out && !states[`${out.price_prefix}blue_hc`]) {
    out.price_prefix = PRICE_PREFIXES.find((p) => states[`${p}blue_hc`]) || out.price_prefix;
  }
  return out;
};

/** Classe de thème de la carte :
 *  v2   : style MyElectricalData, toujours bleu nuit ;
 *  auto : style MyElectricalData, bleu nuit si Home Assistant est en mode sombre, clair sinon ;
 *  ha   : couleurs du thème Home Assistant (clair ou sombre). */
const themeClass = (theme, hass) => {
  const light = hass?.themes?.darkMode === false;
  if (theme === "ha") return `th-ha${light ? " light" : ""}`;
  if (theme === "auto") return `th-v2${light ? " light" : ""}`;
  return "th-v2";
};

const DEFAULTS = {
  title: "Linky",
  days: 14,
  subscribed_power: null,
  tempo_today: "sensor.rte_tempo_today",
  tempo_tomorrow: "sensor.rte_tempo_tomorrow",
  tempo_info: "sensor.edf_tempo_info",
  price_prefix: "sensor.edf_tempo_price_",
  ecowatt: "sensor.rte_ecowatt_j0",
  show_cost: true,
  theme: "v2",
  show_pdl: true,
  show_tempo: true,
  show_ecowatt: true,
  show_week: false,
  show_power: true,
  tiles_horizontal: false,
  font_size: 100,
};

/** Couleurs HC / HP réglables (éditeur visuel : roue de couleurs) */
const HC_HP_COLORS = [
  { key: "hc_color", label: "Couleur des heures creuses (HC)", def: "#4a7bd8" },
  { key: "hp_color", label: "Couleur des heures pleines (HP)", def: "#d27333" },
  { key: "base_color", label: "Couleur des barres en Base (sans HC/HP)", def: "#4a7bd8" },
  // Couleurs selon la couleur Tempo du jour : sans réglage, celles des heures creuses / pleines ci-dessus
  ...["blue", "white", "red"].flatMap((t) =>
    ["hc", "hp"].map((k) => ({
      key: `${k}_${t}_color`,
      label: `${k.toUpperCase()} · jour ${{ blue: "Bleu", white: "Blanc", red: "Rouge" }[t]}`,
      group: "tempo",
      fallback: `${k}_color`,
    })),
  ),
];

/** Présentation de la carte Enedis Linky New (content-card-linky-new), reprise telle quelle. */
class LinkyLook extends HTMLElement {
  static getConfigElement() {
    return document.createElement("content-card-linky-new-editor");
  }

  static getStubConfig(hass) {
    const e = Object.keys(hass?.states || {}).find((id) => /^sensor\.linky_\d+_consumption$/.test(id));
    return { entity: e || "sensor.linky_<pdl>_consumption" };
  }

  setConfig(config) {
    if (!config || !config.entity) throw new Error("Indiquez l'entité de consommation (sensor.linky_<pdl>_consumption).");
    this._config = { ...DEFAULTS, ...config, days: Number(config.days || DEFAULTS.days) };
    this._baseConfig = this._config;
    this._selected = 0;
    this._sig = null;
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
      this.shadowRoot.addEventListener("click", (ev) => {
        const t = ev.target.closest("[data-i]");
        if (!t) return;
        this._selected = Number(t.dataset.i);
        this._render(true);
      });
    }
    this._render(true);
  }

  set hass(hass) {
    this._hass = hass;
    if (this._baseConfig) this._config = withAliases(this._baseConfig, hass);
    this._render(false);
  }

  getCardSize() {
    return 7;
  }

  _state(id) {
    return id ? this._hass?.states?.[id] : undefined;
  }

  /** Ne redessine que si une entité utilisée a changé. */
  _signature() {
    const c = this._config;
    const ids = [c.entity, c.tempo_today, c.tempo_tomorrow, c.ecowatt, ...TEMPO_INFO_IDS(c.tempo_info)];
    for (const col of ["blue", "white", "red"]) for (const h of ["hc", "hp"]) ids.push(`${c.price_prefix}${col}_${h}`);
    return `${c.theme}|${this._hass?.themes?.darkMode}|` + ids.map((id) => this._state(id)?.last_updated || "-").join("|");
  }

  _prices() {
    const c = this._config;
    const out = {};
    let any = false;
    for (const col of ["blue", "white", "red"]) {
      out[col] = {};
      for (const h of ["hc", "hp"]) {
        const v = MED.num(this._state(`${c.price_prefix}${col}_${h}`)?.state);
        out[col][h] = v;
        if (v !== null) any = true;
      }
    }
    return any ? out : null;
  }

  _render(force) {
    if (!this._config || !this._hass || !this.shadowRoot) return;
    const sig = this._signature();
    if (!force && sig === this._sig) return;
    this._sig = sig;

    const c = this._config;
    const mode = themeClass(c.theme, this._hass);
    const main = this._state(c.entity);
    if (!main) {
      this.shadowRoot.innerHTML = `${STYLE}<ha-card class="${mode}"><div class="empty">
        <strong>Entité introuvable : ${esc(c.entity)}</strong>
        <span>Activez l'export Home Assistant dans l'interface MyElectricalData, puis choisissez le capteur
        <code>sensor.linky_&lt;pdl&gt;_consumption</code> dans la configuration de la carte.</span></div></ha-card>`;
      return;
    }

    const a = main.attributes || {};
    const all = MED.days(a);
    // Sans Tempo (show_tempo: false), les prix Tempo ne servent pas au calcul du coût
    const prices = c.show_cost && c.show_tempo !== false ? this._prices() : null;
    const hpPct = MED.num(a.peak_offpeak_percent);
    // Source du coût, par priorité :
    // 1. prix saisis dans la carte (contrat dont les prix ne sont pas dans MyElectricalData) ;
    // 2. offre avec prix HC/HP (Base, HC/HP, Zen Fixe…) : coûts de MyElectricalData, au prix de cette offre ;
    // 3. sinon (Tempo) : calcul de la carte avec les prix Tempo du jour.
    const manual = c.show_cost ? manualPrices(c) : null;
    const offerPriced = !manual && c.show_cost && all.some((d) => d.offerCost !== null);
    // Contrat Base : aucun jour avec un détail HC/HP. Les barres prennent base_color au lieu du gris
    // des jours en attente, et rien n'annonce un détail HC/HP qui ne viendra jamais.
    const base = all.some((d) => d.total !== null) && !all.some((d) => d.hc !== null && d.hp !== null);
    this._base = base;
    all.forEach((d) => {
      d.est = !base && (d.hc === null || d.hp === null) ? MED.estimate(d, hpPct) : null;
      if (manual) {
        d.cost = manualCost(d, manual);
        d.costEst = d.cost === null && d.est ? manualCost({ ...d, ...d.est }, manual) : null;
        return;
      }
      d.cost = offerPriced ? d.offerCost : MED.cost(d, prices);
      d.costEst = !offerPriced && d.cost === null && d.est ? MED.cost({ ...d, ...d.est }, prices) : null;
    });
    this._offerPriced = offerPriced;
    this._manualPriced = !!manual;
    // Abonnement mensuel saisi : ajouté à chaque jour, au prorata des jours du mois (18,36 € en octobre : 0,59 €/jour)
    const sub = c.show_cost ? positivePrice(c.subscription_price) : null;
    this._subscription = sub;
    if (sub !== null) {
      all.forEach((d) => {
        if (!d.date) return;
        d.sub = sub / new Date(d.date.getFullYear(), d.date.getMonth() + 1, 0).getDate();
        if (d.cost !== null) d.cost += d.sub;
        if (d.costEst !== null) d.costEst += d.sub;
      });
    }

    const shown = all.slice(0, Math.max(1, Math.min(c.days, all.length)));
    if (this._selected >= shown.length) this._selected = 0;

    const pdl = (c.entity.match(/linky_(\d+)_/) || [])[1];

    this.shadowRoot.innerHTML = `${STYLE}<ha-card class="${mode}"${hcHpStyle(c)}>
      ${this._header(pdl)}
      ${this._hero(all[0], a, prices)}
      ${this._tiles(a, all)}
      ${this._chart(shown)}
      ${this._selected > 0 ? this._detail(shown[this._selected]) : ""}
      ${c.show_power !== false ? this._power(shown) : ""}
      ${this._ecowatt()}
      ${this._footer(all, prices, hpPct)}
    </ha-card>`;
  }

  /* ---------------------------------------------------------- en-tête */

  _pill(entity, label) {
    const st = this._state(entity);
    const key = st ? String(st.state).toLowerCase() : null;
    const t = TEMPO[key];
    return `<div class="pill ${t ? t.cls : "t-none"}" title="${esc(entity)}">
      <span class="dot"></span><span class="pill-l">${label}</span>
      <span class="pill-v">${t ? t.label : "Non publié"}</span></div>`;
  }

  _header(pdl) {
    const c = this._config;
    const showTempo = c.show_tempo !== false;
    const info = TEMPO_INFO_IDS(c.tempo_info).map((id) => this._state(id)).find(Boolean);
    const left = showTempo ? MED.tempoLeft(info?.attributes) : null;
    const quotas = left
      ? `<div class="quotas">${["blue", "white", "red"]
          .filter((k) => left[k])
          .map((k) => `<span class="quota ${TEMPO[k].cls}"><span class="dot"></span>${left[k].left}<small>/${left[k].quota}</small></span>`)
          .join("")}<span class="quota-l">jours restants</span></div>`
      : "";
    return `<header>
      <div class="brand">
        <svg viewBox="0 0 32 32" aria-hidden="true"><path class="house" d="M4 14.5 16 4l12 10.5V27a1.5 1.5 0 0 1-1.5 1.5h-5M10.5 28.5h-5A1.5 1.5 0 0 1 4 27V14.5"/><path class="bolt" d="M17.5 9 11 18h4.5l-1.5 8 7-10h-4.6z"/></svg>
        <div><div class="title">${esc(c.title)}</div>${pdl && c.show_pdl !== false ? `<div class="sub">PDL ${pdl}</div>` : ""}</div>
      </div>
      ${showTempo ? `<div class="tempo">${this._pill(c.tempo_today, "Aujourd'hui")}${this._pill(c.tempo_tomorrow, "Demain")}</div>` : ""}
    </header>${quotas}`;
  }

  /* ------------------------------------------------------------- hier */

  _hero(day, a, prices) {
    if (!day) return "";
    const total = MED.num(a.yesterday) ?? day.total;
    const evo = MED.num(a.yesterday_evolution);
    const split = day.hc !== null && day.hp !== null && day.hc + day.hp > 0;
    const hcPct = split ? (day.hc / (day.hc + day.hp)) * 100 : 0;
    const when = day.date ? day.date.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" }) : "Hier";
    return `<section class="hero">
      <div>
        <div class="hero-l">${esc(cap(when))}</div>
        <div class="hero-v">${fmt(total, 2)}<span>kWh</span></div>
        ${evo !== null ? `<div class="evo ${evo > 0 ? "up" : "down"}">${evo > 0 ? "+" : ""}${fmt(evo, 1)} % par rapport à la veille</div>` : ""}
      </div>
      <div class="hero-r">
        ${
          !this._config.show_cost
            ? ""
            : day.cost !== null
            ? `<div class="cost">${euro(day.cost)}</div><div class="cost-l">coût de la journée${day.sub ? `, dont abonnement ${euro(day.sub)}` : ""}</div>`
            : day.costEst !== null
              ? `<div class="cost est">≈ ${euro(day.costEst)}</div><div class="cost-l">coût estimé, en attendant le détail HC/HP</div>`
              : `<div class="cost none">—</div><div class="cost-l">${this._base ? "coût indisponible pour ce jour" : this._manualPriced || this._offerPriced || (prices && (day.hc === null || day.hp === null)) ? "coût disponible avec le détail HC/HP" : !prices ? "prix Tempo introuvables" : "couleur Tempo du jour inconnue"}</div>`
        }
        ${day.mp !== null ? `<div class="hero-p">Pic ${fmt(day.mp, 2)} kVA${day.mpTime ? ` à ${day.mpTime.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}` : ""}</div>` : ""}
      </div>
      ${
        split
          ? `<div class="split${TEMPO[day.tempo] ? ` tb-${day.tempo}` : ""}"><div class="bar"><i class="hc" style="width:${hcPct}%"></i><i class="hp" style="width:${100 - hcPct}%"></i></div>
             <div class="split-l"><span class="k-hc">Heures creuses ${fmt(day.hc, 2)} kWh</span><span class="k-hp">Heures pleines ${fmt(day.hp, 2)} kWh</span></div></div>`
          : this._base ? "" : `<div class="split wait">Détail heures creuses / heures pleines pas encore publié par Enedis</div>`
      }
    </section>`;
  }

  /* ------------------------------------------------------------ tuiles */

  _tile(label, value, unit, evo, note, evoSuffix = "") {
    const e = MED.num(evo);
    return `<div class="tile">
      <div class="tile-l">${cap(label)}</div>
      <div class="tile-v">${value}<span>${unit}</span></div>
      ${e !== null ? `<div class="evo ${e > 0 ? "up" : "down"}">${e > 0 ? "+" : ""}${fmt(e, 1)} %${evoSuffix}</div>` : ""}
      ${note ? `<div class="tile-n">${note}</div>` : ""}
    </div>`;
  }

  /** Semaine en cours (lundi à hier) comparée à la même période de la semaine dernière. */
  _weekTiles(a, all) {
    const DAY = 86400000;
    const dayOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const today = dayOf(new Date());
    const monday = new Date(today.getTime() - ((today.getDay() + 6) % 7) * DAY);
    const prevMonday = new Date(monday.getTime() - 7 * DAY);
    const short = (d) => d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
    const cw = MED.num(a.current_week);
    const lw = MED.num(a.last_week);
    // Jours de la semaine en cours déjà publiés (données à J-1)
    const inRange = (from, to) => all.filter((d) => d.date && d.total !== null && dayOf(d.date) >= from && dayOf(d.date) <= to);
    const done = inRange(monday, today);
    let cwNote = "";
    let cwEvo = null;
    if (!done.length) {
      cwNote = "Pas encore de données (J-1)";
    } else {
      const lastDone = dayOf(done.reduce((m, d) => (d.date > m ? d.date : m), done[0].date));
      const span = Math.round((lastDone - monday) / DAY);
      const same = inRange(prevMonday, new Date(prevMonday.getTime() + span * DAY));
      if (same.length === span + 1) {
        const ref = same.reduce((t, d) => t + d.total, 0);
        if (cw !== null && ref > 0) cwEvo = ((cw - ref) / ref) * 100;
        cwNote = `Semaine dernière à date : ${fmt(ref, 0)} kWh`;
      }
    }
    const sunday = new Date(monday.getTime() - DAY);
    return `${this._tile("Semaine en cours", done.length ? fmt(cw, 0) : "—", "kWh", cwEvo, cwNote, cwEvo !== null ? " à date" : "")}
      ${this._tile("Semaine dernière", fmt(lw, 0), "kWh", null, `Du ${short(prevMonday)} au ${short(sunday)}`)}`;
  }

  _tiles(a, all) {
    const now = new Date();
    const month = (offset, year = 0) =>
      new Date(now.getFullYear() + year, now.getMonth() + offset, 1).toLocaleDateString("fr-FR", { month: "long", year: year ? "numeric" : undefined });
    const cm = MED.num(a.current_month);
    const cmLy = MED.num(a.current_month_last_year);
    const lm = MED.num(a.last_month);
    const lmLy = MED.num(a.last_month_last_year);
    const cy = MED.num(a.current_year);
    const cyLy = MED.num(a.current_year_last_year);
    const hp = MED.num(a.peak_offpeak_percent);
    // Projection fin de mois : comparer 5 jours à un mois complet n'a pas de sens.
    const last = all.find((d) => d.total !== null && d.date);
    let proj = null;
    if (cm !== null && last && last.date.getMonth() === now.getMonth() && last.date.getFullYear() === now.getFullYear()) {
      const done = last.date.getDate();
      const len = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      if (done >= 3) proj = (cm / done) * len;
    }
    const cmEvo = proj !== null && cmLy ? ((proj - cmLy) / cmLy) * 100 : null;
    const cmNote = [
      proj !== null ? `Projection : ${fmt(proj, 0)} kWh` : "",
      cmLy !== null ? `${cap(month(0, -1))} : ${fmt(cmLy, 0)} kWh` : "",
    ].filter(Boolean).join("<br>");
    const week = this._config.show_week ? this._weekTiles(a, all) : "";
    const curMonth = this._tile(`${month(0)} en cours`, fmt(cm, 0), "kWh", cmEvo, cmNote, cmEvo !== null ? " sur projection" : "");
    const lastMonth = this._tile(month(-1), fmt(lm, 0), "kWh", a.monthly_evolution, lmLy !== null ? `${cap(month(-1, -1))} : ${fmt(lmLy, 0)} kWh` : "");
    const year = this._tile(`Année ${now.getFullYear()}`, fmt(cy, 0), "kWh", a.yearly_evolution, cyLy !== null ? `À date en ${now.getFullYear() - 1} : ${fmt(cyLy, 0)} kWh` : "");
    const share = this._base ? this._baseAvgTile(all) : this._tile("Part heures pleines", fmt(hp, 1), "%", null, "de la consommation");
    // Disposition horizontale (avec la semaine) : 3 colonnes de 2 cases, de la plus courte période à la plus longue,
    // semaine | mois | année (en cours en haut, précédente en bas)
    if (week && this._config.tiles_horizontal) {
      return `<section class="tiles six h3">${week}${curMonth}${lastMonth}${year}${share}</section>`;
    }
    return `<section class="tiles${week ? " six" : ""}">${week}${curMonth}${lastMonth}${year}${share}</section>`;
  }

  /** Contrat Base : la part d'heures pleines n'a pas de sens, la tuile donne la moyenne par jour sur 30 jours. */
  _baseAvgTile(all) {
    const last = all.filter((d) => d.total !== null).slice(0, 30);
    const avg = last.length ? last.reduce((t, d) => t + d.total, 0) / last.length : null;
    return this._tile("Moyenne par jour", fmt(avg, 2), "kWh", null, last.length ? `sur les ${last.length} derniers jours` : "");
  }

  /* ---------------------------------------------------------- graphique */

  _chart(days) {
    const chrono = days.map((d, i) => ({ ...d, i })).reverse();
    const n = chrono.length;
    const max = Math.max(1, ...chrono.map((d) => d.total || 0)) * 1.08;
    const H = 100;
    const slot = 100 / n;
    const w = slot * 0.62;
    const bars = chrono
      .map((d, k) => {
        const x = k * slot + (slot - w) / 2;
        const tb = TEMPO[d.tempo] ? ` tb-${d.tempo}` : "";
        const sel = d.i === this._selected ? `<rect class="sel" x="${k * slot}" y="0" width="${slot}" height="${H}"/>` : "";
        let body = "";
        if (d.hc !== null && d.hp !== null) {
          const hHc = (d.hc / max) * H;
          const hHp = (d.hp / max) * H;
          body = `<rect class="hc${tb}" x="${x}" y="${H - hHc}" width="${w}" height="${hHc}"/>
                  <rect class="hp${tb}" x="${x}" y="${H - hHc - hHp}" width="${w}" height="${hHp}"/>`;
        } else if (d.est) {
          const hHc = (d.est.hc / max) * H;
          const hHp = (d.est.hp / max) * H;
          body = `<g class="est"><title>Total ${fmt(d.total, 2)} kWh, répartition HC/HP estimée</title>
                  <rect class="hc${tb}" x="${x}" y="${H - hHc}" width="${w}" height="${hHc}"/>
                  <rect class="hp${tb}" x="${x}" y="${H - hHc - hHp}" width="${w}" height="${hHp}"/></g>`;
        } else if (d.total !== null) {
          const h = (d.total / max) * H;
          body = `<rect class="${this._base ? "base" : "partial"}" x="${x}" y="${H - h}" width="${w}" height="${h}"/>`;
        }
        return `${sel}${body}<rect class="hit" data-i="${d.i}" x="${k * slot}" y="0" width="${slot}" height="${H}"/>`;
      })
      .join("");
    const showTempo = this._config.show_tempo !== false;
    const labels = chrono
      .map((d) => {
        const t = showTempo ? TEMPO[d.tempo] : null;
        const name = d.date ? d.date.toLocaleDateString("fr-FR", { weekday: n > 14 ? "narrow" : "short" }).replace(".", "") : "";
        const num = d.date ? d.date.getDate() : "";
        return `<button class="day ${t ? t.cls : ""} ${d.i === this._selected ? "on" : ""}" data-i="${d.i}" title="${t ? `Jour ${t.label.toLowerCase()}` : ""}">
          <span>${name}</span><b>${num}</b>${showTempo ? '<i class="dot"></i>' : ""}</button>`;
      })
      .join("");
    // Couleurs Tempo réglées : une paire HC / HP par couleur Tempo présente sur la période
    let legend = this._base ? '<i class="k-base"></i>Base' : '<i class="k-hc"></i>HC<i class="k-hp"></i>HP';
    if (!this._base && hasTempoColors(this._config)) {
      const present = TEMPO_KEYS.filter((t) => chrono.some((d) => d.tempo === t));
      const others = chrono.some((d) => !TEMPO[d.tempo] && (d.hc !== null || d.est));
      legend = `<span class="legend-t">HC / HP</span>${present.map((t) => `<i class="k-hc tb-${t}"></i><i class="k-hp tb-${t} pair"></i>${TEMPO[t].label}`).join("")}${
        others ? '<i class="k-hc"></i><i class="k-hp pair"></i>Autres' : ""}`;
    }
    return `<section class="chart">
      <div class="chart-h"><span>${n} derniers jours</span>
        <span class="legend">${legend}</span></div>
      <svg viewBox="0 0 100 ${H}" preserveAspectRatio="none" role="img" aria-label="Consommation des ${n} derniers jours">${bars}</svg>
      <div class="days" style="grid-template-columns:repeat(${n},1fr)">${labels}</div>
    </section>`;
  }

  _detail(d) {
    if (!d || !d.date) return "";
    const when = d.date.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
    const t = this._config.show_tempo !== false ? TEMPO[d.tempo] : null;
    const parts = [`<b>${fmt(d.total, 2)} kWh</b>`];
    if (d.hc !== null && d.hp !== null) parts.push(`HC ${fmt(d.hc, 2)}`, `HP ${fmt(d.hp, 2)}`);
    else if (!this._base) parts.push("détail HC/HP en attente");
    if (d.cost !== null) parts.push(euro(d.cost));
    else if (d.costEst !== null) parts.push(`≈ ${euro(d.costEst)}`);
    const peak =
      d.mp !== null
        ? `Pic ${fmt(d.mp, 2)} kVA${d.mpTime ? ` à ${d.mpTime.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}` : ""}${d.mpOver ? ' <em class="warn">dépassement</em>' : ""}`
        : "";
    return `<section class="detail">
      <div class="detail-h">${t ? `<span class="tag ${t.cls}">${t.label}</span>` : ""}<span>${esc(cap(when))}</span></div>
      <div class="detail-v">${parts.join("<span class=\"sep\"></span>")}</div>
      ${peak ? `<div class="detail-p">${peak}</div>` : ""}
    </section>`;
  }

  /* ------------------------------------------------- puissance max */

  _power(days) {
    const withMp = days.filter((d) => d.mp !== null);
    if (!withMp.length) return "";
    const top = withMp.reduce((m, d) => (d.mp > m.mp ? d : m));
    const sub = MED.num(this._config.subscribed_power);
    const over = days.some((d) => d.mpOver);
    const pct = sub ? Math.min(100, (top.mp / sub) * 100) : null;
    const when = top.date ? top.date.toLocaleDateString("fr-FR", { day: "numeric", month: "long" }).replace(/^1 /, "1er ") : "";
    const hour = top.mpTime ? top.mpTime.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : "";
    return `<section class="power ${over ? "is-over" : ""}">
      <div class="power-t"><span>Puissance maximale sur ${days.length} jours</span><b>${fmt(top.mp, 2)} kVA</b></div>
      ${pct !== null ? `<div class="gauge"><i style="width:${pct}%"></i></div>` : ""}
      <div class="power-n">Le ${esc(when)}${hour ? ` à ${hour}` : ""}${sub ? `, pour ${fmt(sub, 0)} kVA souscrits` : ""}${
        over ? ". Dépassement de la puissance souscrite sur la période." : ""
      }</div>
    </section>`;
  }

  /* ---------------------------------------------------------- EcoWatt */

  _ecowatt() {
    if (this._config.show_ecowatt === false) return "";
    const st = this._state(this._config.ecowatt);
    if (!st || ["unknown", "unavailable", ""].includes(String(st.state))) return "";
    const LEVELS = {
      1: { cls: "e-ok", label: "Pas d'alerte" },
      2: { cls: "e-warn", label: "Système électrique tendu" },
      3: { cls: "e-alert", label: "Système très tendu, coupures possibles" },
    };
    const lvl = LEVELS[Math.round(Number(st.state))];
    const msg = st.attributes?.message || (lvl ? lvl.label : st.state);
    return `<section class="eco ${lvl ? lvl.cls : ""}" title="${esc(this._config.ecowatt)} : ${esc(st.state)}">
      <span class="eco-l">EcoWatt</span><span class="dot"></span><span>${esc(msg)}</span></section>`;
  }

  /* ----------------------------------------------------------- pied */

  _footer(all, prices, hpPct) {
    const last = all.find((d) => d.total !== null && d.date);
    const bits = [];
    if (last) bits.push(`Données Enedis jusqu'au ${last.date.toLocaleDateString("fr-FR")}`);
    if (this._config.show_cost) {
      const abo = this._subscription ? `abonnement compris (${euro(this._subscription)}/mois)` : "hors abonnement";
      bits.push(this._manualPriced
        ? `coûts estimés ${abo}, au prix saisi dans la carte`
        : this._offerPriced
        ? `coûts estimés ${abo}, au prix de l'offre choisie dans MyElectricalData`
        : prices ? `coûts estimés ${abo}, au prix Tempo du jour` : "prix Tempo introuvables, coûts masqués");
    }
    if (all.some((d) => d.est) && hpPct !== null) bits.push(`barres claires : répartition HC/HP estimée (${fmt(hpPct, 1)} % HP)`);
    return `<footer>${bits.join(", ")}.</footer>`;
  }
}

/* ------------------------------------------------------------------ style */

/** Règles des couleurs par couleur Tempo : sans réglage, elles retombent sur les couleurs HC / HP générales. */
const TEXT_DEFAULT = { hc: ["#8fb0f0", "#2f5fb8"], hp: ["#eaa070", "#b35619"] };
const TEMPO_CSS = TEMPO_KEYS.flatMap((t) =>
  ["hc", "hp"].map((k) => `
.chart rect.${k}.tb-${t} { fill: var(--med-${k}-${t}, var(--med-${k})); }
.split.tb-${t} .bar .${k}, .legend .k-${k}.tb-${t} { background: var(--med-${k}-${t}, var(--med-${k})); }
.split.tb-${t} .k-${k} { color: var(--med-${k}-${t}-text, var(--med-${k}-text, ${TEXT_DEFAULT[k][0]})); }
ha-card.light .split.tb-${t} .k-${k} { color: var(--med-${k}-${t}-text, var(--med-${k}-text, ${TEXT_DEFAULT[k][1]})); }`),
).join("");

const STYLE_BASE = `<style>
:host {
  --med-bg: #1a2434; --med-surface: #212d40; --med-line: #2f3d55;
  --med-text: #e7edf5; --med-muted: #8fa0b8;
  --med-green: #96d21f; --med-blue: #1d93e3;
  --med-hc: #4a7bd8; --med-hp: #d27333;
  --t-blue: #3f7ff0; --t-white: #e9eef4; --t-red: #ee4a4a;
  --med-up: #f08a4b; --med-down: #5fcf8a;
}
ha-card { background: var(--med-bg); color: var(--med-text); border: 1px solid var(--med-line);
  border-radius: 18px; overflow: hidden; font-variant-numeric: tabular-nums; container-type: inline-size; }
header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 18px 8px; flex-wrap: wrap; }
.brand { display: flex; align-items: center; gap: 10px; }
.brand svg { width: 34px; height: 34px; fill: none; }
.brand .house { stroke: var(--med-green); stroke-width: 2.4; stroke-linejoin: round; stroke-linecap: round; }
.brand .bolt { fill: var(--med-accent, var(--med-blue)); }
.title { font-size: 1.15rem; font-weight: 700; letter-spacing: .2px; }
.sub { font-size: .78rem; color: var(--med-muted); }
.tempo { display: flex; gap: 8px; }
.pill { display: flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 999px;
  background: var(--med-surface); border: 1px solid var(--med-line); font-size: .78rem; }
.pill-l { color: var(--med-muted); }
.pill-v { font-weight: 600; }
.dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; background: var(--med-muted); flex: none; }
.t-blue .dot { background: var(--t-blue); } .t-white .dot { background: var(--t-white); } .t-red .dot { background: var(--t-red); }
.t-none .pill-v { color: var(--med-muted); font-weight: 400; }
.quotas { display: flex; align-items: center; gap: 14px; padding: 0 18px 10px; font-size: .82rem; }
.quota { display: inline-flex; align-items: center; gap: 5px; font-weight: 600; }
.quota small { color: var(--med-muted); font-weight: 400; }
.quota-l { color: var(--med-muted); }

.hero { margin: 4px 12px 0; padding: 16px; border-radius: 14px; background: var(--med-surface);
  border: 1px solid var(--med-line); display: grid; grid-template-columns: 1fr auto; gap: 6px 16px; }
.hero-l { color: var(--med-muted); font-size: .85rem; }
.hero-v { font-size: 2.4rem; font-weight: 700; line-height: 1.1; }
.hero-v span, .tile-v span { font-size: .9rem; font-weight: 500; color: var(--med-muted); margin-left: 4px; }
.hero-r { text-align: right; align-self: center; }
.cost { font-size: 1.6rem; font-weight: 700; color: var(--med-green); }
.cost.none { color: var(--med-muted); }
.cost.est { color: var(--med-text); opacity: .85; }
.hero-p { font-size: .75rem; color: var(--med-muted); margin-top: 6px; }
.cost-l { font-size: .75rem; color: var(--med-muted); max-width: 160px; }
.evo { font-size: .8rem; font-weight: 600; margin-top: 2px; }
.evo.up { color: var(--med-up); } .evo.down { color: var(--med-down); }
.split { grid-column: 1 / -1; margin-top: 6px; }
.split.wait { font-size: .8rem; color: var(--med-muted); border-top: 1px dashed var(--med-line); padding-top: 8px; }
.bar { display: flex; height: 8px; border-radius: 6px; overflow: hidden; background: var(--med-line); }
.bar i { display: block; } .bar .hc { background: var(--med-hc); } .bar .hp { background: var(--med-hp); }
.split-l { display: flex; justify-content: space-between; font-size: .78rem; margin-top: 6px; }
.k-hc { color: var(--med-hc-text, #8fb0f0); } .k-hp { color: var(--med-hp-text, #eaa070); }

.tiles { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin: 10px 12px 0; }
@container (min-width: 620px) { .tiles { grid-template-columns: repeat(4, 1fr); } }
@container (min-width: 620px) { .tiles.six { grid-template-columns: repeat(3, 1fr); } }
.tile { padding: 12px; border-radius: 12px; border: 1px solid var(--med-line); }
.tile-l { font-size: .78rem; color: var(--med-muted); }
.tile-v { font-size: 1.35rem; font-weight: 700; margin-top: 2px; }
.tile-n { font-size: .72rem; color: var(--med-muted); margin-top: 4px; }

.chart { margin: 14px 12px 0; }
.chart-h { display: flex; justify-content: space-between; font-size: .82rem; color: var(--med-muted); margin: 0 4px 6px; }
.legend { display: flex; align-items: center; gap: 6px; }
.legend i { width: 10px; height: 10px; border-radius: 3px; display: inline-block; margin-left: 6px; }
.legend .k-hc { background: var(--med-hc); } .legend .k-hp { background: var(--med-hp); }
.chart-h { flex-wrap: wrap; row-gap: 4px; }
.chart-h > span:first-child, .legend .legend-t { white-space: nowrap; }
.legend .legend-t { margin-right: 2px; }
.legend i.pair { margin-left: 2px; }
${TEMPO_CSS}
.chart svg { width: 100%; height: 130px; display: block; }
.chart rect.hc { fill: var(--med-hc); } .chart rect.hp { fill: var(--med-hp); }
.chart rect.partial { fill: var(--med-muted); opacity: .35; }
.chart rect.base { fill: var(--med-base, var(--med-hc)); }
.legend .k-base { background: var(--med-base, var(--med-hc)); }
.chart g.est { opacity: .45; }
.chart rect.sel { fill: rgba(255,255,255,.06); }
.chart rect.hit { fill: transparent; cursor: pointer; }
.days { display: grid; margin-top: 4px; }
.day { all: unset; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 1px;
  padding: 4px 0; border-radius: 8px; font-size: .68rem; color: var(--med-muted); text-transform: capitalize; }
.day b { color: var(--med-text); font-size: .78rem; }
.day .dot { width: 6px; height: 6px; margin-top: 2px; }
.day.on { background: var(--med-surface); }
.day:focus-visible { outline: 2px solid var(--med-accent, var(--med-blue)); }

.detail { margin: 8px 12px 0; padding: 10px 12px; border-radius: 12px; background: var(--med-surface); border: 1px solid var(--med-line); }
.detail-h { display: flex; align-items: center; gap: 8px; font-size: .8rem; color: var(--med-muted); }
.tag { padding: 1px 8px; border-radius: 999px; font-size: .72rem; font-weight: 700; color: #0f1724; }
.tag.t-blue { background: var(--t-blue); color: #fff; } .tag.t-white { background: var(--t-white); } .tag.t-red { background: var(--t-red); color: #fff; }
.detail-v { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin-top: 4px; font-size: .9rem; }
.sep { width: 1px; height: 12px; background: var(--med-line); }
.detail-p { font-size: .78rem; color: var(--med-muted); margin-top: 4px; }
.warn { color: var(--t-red); font-style: normal; font-weight: 600; }

.power { margin: 10px 12px 0; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--med-line); }
.power.is-over { border-color: var(--t-red); }
.power-t { display: flex; justify-content: space-between; font-size: .85rem; }
.gauge { height: 6px; border-radius: 6px; background: var(--med-line); margin: 8px 0 6px; overflow: hidden; }
.gauge i { display: block; height: 100%; background: linear-gradient(90deg, var(--med-green), var(--med-accent, var(--med-blue))); }
.is-over .gauge i { background: var(--t-red); }
.power-n { font-size: .75rem; color: var(--med-muted); }

.eco { margin: 10px 12px 0; padding: 8px 12px; border-radius: 12px; border: 1px solid var(--med-line); font-size: .82rem; display: flex; align-items: center; gap: 8px; }
.eco.e-ok .dot { background: var(--med-down); }
.eco.e-warn { border-color: #f0a33a; } .eco.e-warn .dot { background: #f0a33a; }
.eco.e-alert { border-color: var(--t-red); } .eco.e-alert .dot { background: var(--t-red); }
.eco-l { color: var(--med-muted); }
footer { padding: 10px 18px 14px; font-size: .7rem; color: var(--med-muted); }
.empty { padding: 18px; display: flex; flex-direction: column; gap: 6px; font-size: .9rem; }
.empty span { color: var(--med-muted); }
/* Thème Home Assistant : fond, textes et bordures suivent le thème clair ou sombre */
ha-card.th-ha {
  /* accent (icônes, onglets, sélections, contours) : couleur principale du thème ; les bleus porteurs de sens restent bleus */
  --med-accent: var(--primary-color, #1d93e3);
  --med-on-accent: var(--text-primary-color, #fff);
  --med-bg: var(--ha-card-background, var(--card-background-color, #fff));
  --med-surface: color-mix(in srgb, var(--primary-text-color, #000) 5%, transparent);
  --med-line: var(--divider-color, rgba(127, 127, 127, .25));
  --med-text: var(--primary-text-color, #1f2937);
  --med-muted: var(--secondary-text-color, #6b7280);
  border-radius: var(--ha-card-border-radius, 12px);
  border: var(--ha-card-border-width, 1px) solid var(--ha-card-border-color, var(--divider-color, #e0e0e0));
}
ha-card.th-ha.light { --med-green: #4c8a0b; --med-up: #c2560f; --med-down: #1d8a4b; }
/* Style MyElectricalData en version claire (theme: auto quand Home Assistant est en mode clair) */
ha-card.th-v2.light {
  --med-bg: #ffffff; --med-surface: #f2f5f9; --med-line: #dbe2ec;
  --med-text: #1a2434; --med-muted: #5b6b82;
  --med-green: #4c8a0b; --med-blue: #1673b8; --med-up: #c2560f; --med-down: #1d8a4b;
  box-shadow: 0 1px 3px rgba(26, 36, 52, .08);
}
ha-card.light .k-hc { color: var(--med-hc-text, #2f5fb8); }
ha-card.light .k-hp { color: var(--med-hp-text, #b35619); }
ha-card.light .t-white .dot, ha-card.light .tag.t-white { box-shadow: inset 0 0 0 1px #aab3c0; }
ha-card.light .chart rect.sel { fill: rgba(0, 0, 0, .05); }
ha-card.light .tag.t-white { color: #1f2937; }
@media (max-width: 420px) { .hero-v { font-size: 2rem; } .tempo { width: 100%; } }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
.tiles.h3 { grid-template-columns: repeat(3, 1fr); grid-template-rows: repeat(2, auto); grid-auto-flow: column; }
.tiles.h3 .tile { padding: 8px 10px; min-width: 0; }
@container (max-width: 420px) { .tiles.h3 .tile-v { font-size: 1.1rem; } .tiles.h3 .tile-n { font-size: .66rem; } }
</style>`;
// Variable --fs (réglage « taille de la police ») : sans réglage elle vaut 1 et rien ne change.
const STYLE = STYLE_BASE.replace(/(-?\d*\.?\d+)rem/g, "calc($1rem * var(--fs, 1))");

/* ----------------------------------------------------------------- éditeur */

const SCHEMA = [
  { name: "entity", required: true, selector: { entity: { domain: "sensor" } } },
  { name: "title", selector: { text: {} } },
  {
    name: "days",
    selector: {
      select: {
        mode: "dropdown",
        options: [
          { value: "7", label: "7 jours" },
          { value: "14", label: "14 jours" },
          { value: "31", label: "31 jours" },
        ],
      },
    },
  },
  { name: "subscribed_power", selector: { number: { min: 3, max: 36, step: 3, mode: "box", unit_of_measurement: "kVA" } } },
  // Prix de son contrat, quand ils ne sont pas dans MyElectricalData (facultatifs)
  { name: "subscription_price", selector: { number: { min: 0, max: 200, step: 0.01, mode: "box", unit_of_measurement: "€/mois" } } },
  { name: "hc_price", selector: { number: { min: 0, max: 2, step: 0.0001, mode: "box", unit_of_measurement: "€/kWh" } } },
  { name: "hp_price", selector: { number: { min: 0, max: 2, step: 0.0001, mode: "box", unit_of_measurement: "€/kWh" } } },
  { name: "base_price", selector: { number: { min: 0, max: 2, step: 0.0001, mode: "box", unit_of_measurement: "€/kWh" } } },
  {
    name: "theme",
    selector: {
      select: {
        mode: "dropdown",
        options: [
          { value: "v2", label: "Style MyElectricalData (bleu nuit)" },
          { value: "auto", label: "Style MyElectricalData, clair ou sombre selon Home Assistant" },
          { value: "ha", label: "Thème Home Assistant (clair ou sombre)" },
        ],
      },
    },
  },
  { name: "show_cost", selector: { boolean: {} } },
  { name: "show_pdl", selector: { boolean: {} } },
  { name: "show_tempo", selector: { boolean: {} } },
  { name: "show_ecowatt", selector: { boolean: {} } },
  { name: "show_week", selector: { boolean: {} } },
  { name: "tiles_horizontal", selector: { boolean: {} } },
  { name: "show_power", selector: { boolean: {} } },
  { name: "font_size", selector: { number: { min: 70, max: 150, step: 5, mode: "slider", unit_of_measurement: "%" } } },
  { name: "tempo_today", selector: { entity: { domain: "sensor" } } },
  { name: "tempo_tomorrow", selector: { entity: { domain: "sensor" } } },
  { name: "tempo_info", selector: { entity: { domain: "sensor" } } },
  { name: "ecowatt", selector: { entity: { domain: "sensor" } } },
  { name: "price_prefix", selector: { text: {} } },
];

const LABELS = {
  entity: "Consommation (sensor.linky_<pdl>_consumption)",
  title: "Titre",
  days: "Historique affiché",
  subscribed_power: "Puissance souscrite (kVA du compteur)",
  subscription_price: "Abonnement mensuel TTC (facultatif : ajouté au coût, au prorata des jours)",
  theme: "Couleurs de la carte",
  show_cost: "Afficher les coûts estimés",
  show_pdl: "Afficher le numéro de PDL",
  show_tempo: "Afficher Tempo (couleurs d'aujourd'hui et de demain, jours restants, pastilles du graphique, coût aux prix Tempo) : à couper sans contrat Tempo",
  show_ecowatt: "Afficher EcoWatt",
  show_week: "Afficher la semaine en cours et la semaine dernière",
  tiles_horizontal: "Cases en 3 colonnes (avec la semaine)",
  show_power: "Afficher la puissance maximale sur la période",
  font_size: "Taille de la police (100 % = taille d'origine)",
  tempo_today: "Tempo aujourd'hui",
  tempo_tomorrow: "Tempo demain",
  tempo_info: "Tempo, jours restants",
  ecowatt: "EcoWatt (masqué si indisponible)",
  price_prefix: "Préfixe des capteurs de prix Tempo",
  hc_price: "Prix du kWh en heures creuses, TTC (facultatif : remplace celui de l'offre)",
  hp_price: "Prix du kWh en heures pleines, TTC (facultatif : remplace celui de l'offre)",
  base_price: "Prix du kWh, option Base, TTC (facultatif)",
};

const DAYS_SELECT = SCHEMA.find((s) => s.name === "days");
const THEME_SELECT = SCHEMA.find((s) => s.name === "theme");

const WHEEL_STYLE = `<style>
.med-colors { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-top: 16px; }
.med-colors[hidden] { display: none; }
.med-color { border: 1px solid var(--divider-color, #e0e0e0); border-radius: 12px; padding: 12px; min-width: 0; }
.med-color-t { font-weight: 500; margin-bottom: 10px; display: flex; align-items: center; gap: 8px; }
.med-color-t i { width: 18px; height: 18px; border-radius: 50%; border: 1px solid var(--divider-color, #ccc); flex: none; }
.med-wheel { position: relative; width: 180px; max-width: 100%; aspect-ratio: 1; margin: 0 auto; border-radius: 50%;
  touch-action: none; cursor: crosshair;
  background: radial-gradient(circle closest-side, #fff, rgba(255, 255, 255, 0)),
    conic-gradient(from 90deg, red, yellow, lime, cyan, blue, magenta, red); }
.med-wheel .shade { position: absolute; inset: 0; border-radius: 50%; background: #000; pointer-events: none; }
.med-wheel .dot { position: absolute; width: 18px; height: 18px; margin: -11px 0 0 -11px; border-radius: 50%;
  border: 2px solid #fff; box-shadow: 0 0 0 1px rgba(0, 0, 0, .5), 0 1px 4px rgba(0, 0, 0, .4); pointer-events: none; }
.med-color label { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: .9rem; }
.med-color input[type=range] { flex: 1; min-width: 0; width: 100%; accent-color: var(--primary-color, #03a9f4); }
.med-color-r { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.med-color-r input[type=text] { flex: 1; min-width: 0; font: inherit; padding: 6px 8px; border-radius: 6px;
  border: 1px solid var(--divider-color, #ccc); background: var(--card-background-color, #fff); color: var(--primary-text-color, #000); }
.med-color-r button { font: inherit; font-size: .85rem; padding: 6px 10px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--divider-color, #ccc); background: transparent; color: var(--primary-color, #03a9f4); }
.med-color small { display: block; margin-top: 6px; color: var(--secondary-text-color, #666); }
.med-tempo-t { display: flex; align-items: center; gap: 8px; margin-top: 16px; font-weight: 500; cursor: pointer; }
.med-small { grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; margin-top: 10px; }
.med-small .med-color { padding: 10px; }
.med-small .med-wheel { width: 120px; }
/* Colonnes étroites : luminosité sous son libellé, code et bouton l'un sous l'autre */
.med-small .med-color label { flex-direction: column; align-items: stretch; gap: 4px; font-size: .8rem; }
.med-small .med-color-r { flex-wrap: wrap; }
.med-small .med-color-r input[type=text], .med-small .med-color-r button { flex: 1 1 100%; }
.med-small .med-color-r button { padding: 6px 8px; }
</style>`;

function makeEditor(schema, labels, defaults, colors = []) {
  const hasDays = schema.some((s) => s.name === "days");
  return class extends HTMLElement {
    setConfig(config) {
      this._config = { ...config };
      this._draw();
    }

    set hass(hass) {
      this._hass = hass;
      if (this._form) this._form.hass = hass;
      else this._draw();
    }

    _draw() {
      if (!this._hass || !this._config) return;
      if (!this._form) {
        this._form = document.createElement("ha-form");
        this._form.computeLabel = (s) => labels[s.name] || s.name;
        this._form.addEventListener("value-changed", (ev) => {
          const v = { ...ev.detail.value };
          if (hasDays && v.days !== undefined) v.days = Number(v.days);
          // Les couleurs se règlent avec les roues, hors du formulaire : garder la valeur en cours
          for (const c of colors) {
            if (this._config[c.key] !== undefined) v[c.key] = this._config[c.key];
            else delete v[c.key];
          }
          this._config = v;
          this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: v }, bubbles: true, composed: true }));
        });
        this.appendChild(this._form);
      }
      this._form.hass = this._hass;
      this._form.schema = schema;
      this._form.data = hasDays
        ? { ...defaults, ...this._config, days: String(this._config.days || defaults.days) }
        : { ...defaults, ...this._config };
      if (colors.length) this._drawColors();
    }

    _emit() {
      this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config }, bubbles: true, composed: true }));
    }

    /** Enregistre une couleur (null : retour à la couleur par défaut, l'option disparaît du YAML). */
    _setColor(key, hex) {
      const v = { ...this._config };
      if (hex) v[key] = hex;
      else delete v[key];
      this._config = v;
      // Les roues Tempo non réglées suivent les couleurs HC / HP générales : tout repeindre
      for (const c of colors) this._paintColor(c.key);
      this._emit();
    }

    /** Couleur affichée quand l'option n'est pas réglée : la sienne par défaut, ou celle de l'option de repli. */
    _fallbackHex(c) {
      if (!c.fallback) return c.def;
      const base = colors.find((x) => x.key === c.fallback);
      return toHex(this._config[c.fallback]) || base.def;
    }

    _drawColors() {
      if (!this._colors) {
        const block = (c) => {
          const small = c.group === "tempo";
          const def = c.fallback ? `couleur ${c.key.slice(0, 2).toUpperCase()} ci-dessus` : c.def;
          return `
          <div class="med-color" data-key="${c.key}">
            <div class="med-color-t"><i></i>${esc(c.label)}</div>
            <div class="med-wheel"><div class="shade"></div><div class="dot"></div></div>
            <label>Luminosité <input type="range" min="10" max="100" step="1"></label>
            <div class="med-color-r"><input type="text" spellcheck="false" aria-label="Code couleur">
              <button type="button">${small ? "Par défaut" : "Couleur par défaut"}</button></div>
            <small>Par défaut : ${def}</small>
          </div>`;
        };
        const main = colors.filter((c) => !c.group);
        const tempo = colors.filter((c) => c.group === "tempo");
        this._colors = document.createElement("div");
        this._colors.innerHTML = WHEEL_STYLE + `<div class="med-colors">${main.map(block).join("")}</div>${
          tempo.length
            ? `<label class="med-tempo-t"><input type="checkbox"> Couleurs selon la couleur Tempo du jour (6 roues)</label>
               <div class="med-colors med-small" hidden>${tempo.map(block).join("")}</div>`
            : ""}`;
        this.appendChild(this._colors);
        for (const c of colors) this._bindColor(c);
        const toggle = this._colors.querySelector(".med-tempo-t input");
        if (toggle) {
          const grid = this._colors.querySelector(".med-small");
          toggle.checked = tempo.some((c) => this._config[c.key] !== undefined);
          grid.hidden = !toggle.checked;
          toggle.addEventListener("change", () => {
            grid.hidden = !toggle.checked;
            // Décocher retire les six couleurs Tempo : la carte reprend les couleurs HC / HP générales
            if (!toggle.checked && tempo.some((c) => this._config[c.key] !== undefined)) {
              const v = { ...this._config };
              for (const c of tempo) delete v[c.key];
              this._config = v;
              for (const c of colors) this._paintColor(c.key);
              this._emit();
            }
          });
        }
      }
      for (const c of colors) this._paintColor(c.key);
    }

    _bindColor(c) {
      const box = this._colors.querySelector(`[data-key="${c.key}"]`);
      const wheel = box.querySelector(".med-wheel");
      const range = box.querySelector("input[type=range]");
      const text = box.querySelector("input[type=text]");
      const current = () => hexToHsv(toHex(this._config[c.key]) || this._fallbackHex(c));
      const pick = (ev) => {
        const r = wheel.getBoundingClientRect();
        const dx = ev.clientX - (r.left + r.width / 2), dy = ev.clientY - (r.top + r.height / 2);
        const h = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
        const sat = Math.min(1, Math.hypot(dx, dy) / (r.width / 2));
        this._setColor(c.key, hsvToHex(h, sat, current().v || 1));
      };
      wheel.addEventListener("pointerdown", (ev) => {
        wheel.setPointerCapture(ev.pointerId);
        this._dragging = c.key;
        pick(ev);
      });
      wheel.addEventListener("pointermove", (ev) => { if (this._dragging === c.key) pick(ev); });
      const stop = () => { this._dragging = null; };
      wheel.addEventListener("pointerup", stop);
      wheel.addEventListener("pointercancel", stop);
      range.addEventListener("input", () => {
        const { h, s } = current();
        this._setColor(c.key, hsvToHex(h, s, Number(range.value) / 100));
      });
      text.addEventListener("change", () => {
        const v = text.value.trim();
        if (!v) return this._setColor(c.key, null);
        const hex = toHex(v.startsWith("#") ? v : `#${v}`) || toHex(v);
        if (hex) this._setColor(c.key, hex);
        else this._paintColor(c.key);
      });
      box.querySelector("button").addEventListener("click", () => this._setColor(c.key, null));
    }

    _paintColor(key) {
      const c = colors.find((x) => x.key === key);
      const box = this._colors?.querySelector(`[data-key="${key}"]`);
      if (!c || !box) return;
      const chosen = toHex(this._config[key]);
      const hex = chosen || this._fallbackHex(c);
      const { h, s, v } = hexToHsv(hex);
      const dot = box.querySelector(".dot");
      const rad = (h * Math.PI) / 180;
      dot.style.left = `${50 + 50 * s * Math.cos(rad)}%`;
      dot.style.top = `${50 + 50 * s * Math.sin(rad)}%`;
      dot.style.background = hex;
      box.querySelector(".shade").style.opacity = String(1 - v);
      box.querySelector(".med-color-t i").style.background = hex;
      const range = box.querySelector("input[type=range]");
      if (document.activeElement !== range && this._dragging !== key) range.value = String(Math.round(v * 100));
      const text = box.querySelector("input[type=text]");
      const raw = this._config[key];
      if (document.activeElement !== text) text.value = raw === undefined ? "" : typeof raw === "string" ? raw : chosen || "";
      text.placeholder = this._fallbackHex(c);
    }
  };
}


/* ===================================================================== ZLinky */

/** Lecture des statistiques de Home Assistant (index HC, HP ou Base du LiXee, puissance apparente). */
const ZL = {
  DAY: 86400000,
  dayOf: (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()),
  key: (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
  /** Début d'une ligne de statistiques : nombre (ms) ou date ISO selon la version de Home Assistant. */
  start: (row) => new Date(typeof row.start === "number" ? row.start : Date.parse(row.start)),
  /** Valeur d'un index en kWh d'après son unité (Wh, kWh, MWh). */
  kwh(state) {
    const v = Number(state?.state);
    if (!Number.isFinite(v)) return null;
    const u = String(state.attributes?.unit_of_measurement || "kWh");
    return u === "Wh" ? v / 1000 : u === "MWh" ? v * 1000 : v;
  },
  /** Puissance en kVA d'après son unité (VA, kVA, W, kW). */
  kva(value, unit) {
    const v = Number(value);
    if (!Number.isFinite(v)) return null;
    return /^k/i.test(String(unit || "")) ? v : v / 1000;
  },
  /** Prix d'une statistique dans le tableau Énergie : nombre fixe ou entité de prix (on cherche partout,
   *  la structure des préférences a changé selon les versions de Home Assistant). */
  energyPrice(prefs, statId, hass) {
    let found = null;
    const walk = (o) => {
      if (found !== null || !o || typeof o !== "object") return;
      if (Array.isArray(o)) return o.forEach(walk);
      if (o.stat_energy_from === statId || o.stat_energy === statId) {
        const n = positivePrice(o.number_energy_price);
        const e = o.entity_energy_price ? positivePrice(hass?.states?.[o.entity_energy_price]?.state) : null;
        found = e ?? n;
        return;
      }
      Object.values(o).forEach(walk);
    };
    walk(prefs);
    return found;
  },
};

/** Index du ZLinky : clé de configuration, part (hc, hp, base) et couleur Tempo. */
const ZL_TEMPO_PARTS = ["blue", "white", "red"].flatMap((color) =>
  ["hc", "hp"].map((kind) => ({ key: `${kind}_${color}`, conf: `${kind}_${color}_entity`, kind, color })));

/** Couleur Tempo écrite par le ZLinky (BLEU, BLAN, ROUG…), par RTE (blue…) ou en français. */
const zlColor = (v) => {
  const s = String(v ?? "").toLowerCase();
  if (/^(blue|bleu|bbr.*jb|hcjb|hpjb)/.test(s) || s.includes("bleu")) return "blue";
  if (/^(white|blan|bbr.*jw|hcjw|hpjw)/.test(s) || s.includes("blanc")) return "white";
  if (/^(red|roug|bbr.*jr|hcjr|hpjr)/.test(s) || s.includes("rouge")) return "red";
  return null;
};

/** Index proposés par l'éditeur et dans le message d'erreur : capteurs d'énergie en Wh ou kWh. */
const zlEnergyIds = (hass) =>
  Object.entries(hass?.states || {})
    .filter(([id, st]) => id.startsWith("sensor.") && /^(k|M)?Wh$/.test(String(st.attributes?.unit_of_measurement || "")))
    .map(([id]) => id);

const ZL_DEFAULTS = {
  title: "ZLinky",
  days: 14,
  hc_entity: "",
  hp_entity: "",
  base_entity: "",
  ...Object.fromEntries(ZL_TEMPO_PARTS.map((p) => [p.conf, ""])),
  power_entity: "",
  tariff_entity: "",
  current_entity: "",
  voltage_entity: "",
  max_power_entity: "",
  lqi_entity: "",
  ccasn_entity: "",
  ccasn_prev_entity: "",
  show_ccasn: true,
  show_ccasn_prev: true,
  message_entity: "",
  message2_entity: "",
  show_messages: true,
  show_details: true,
  // sections rabattables : affichées ou masquées, puis ouvertes au départ (l'état choisi est retenu par le navigateur)
  show_live: true,
  show_index: true,
  show_totals: true,
  show_chart: true,
  live_open: true,
  index_open: true,
  totals_open: true,
  chart_open: true,
  message_test: false,
  show_meter: true,
  subscribed_power: null,
  show_cost: true,
  energy_prices: true,
  theme: "v2",
  show_pdl: false,
  show_tempo: false,
  // Capteurs RTE facultatifs : vides par défaut (l'éditeur ne signale pas d'entité inconnue) ; les noms connus
  // sont repris s'ils existent (withAliases)
  tempo_today: "",
  tempo_tomorrow: "",
  tempo_info: "",
  price_prefix: "sensor.edf_tempo_price_",
  ecowatt: "",
  show_ecowatt: true,
  show_week: false,
  show_power: true,
  tiles_horizontal: false,
  font_size: 100,
};

/** Bloc « compteur en direct » : pastilles comme celles de l'ancien tableau de bord. */
const ZL_STYLE = `<style>
ha-card { position: relative; display: block; }
.zl-msg { position: absolute; inset: 0; z-index: 5; display: flex; align-items: flex-start; justify-content: center; padding: 56px 14px 14px;
  background: color-mix(in srgb, var(--med-bg) 55%, transparent); backdrop-filter: blur(2px); border-radius: inherit; }
.zl-msg-box { display: flex; gap: 10px; align-items: flex-start; width: 100%; max-width: 440px; padding: 14px; border-radius: 14px;
  background: var(--med-bg); border: 2px solid #f0a33a; box-shadow: 0 10px 30px rgba(0, 0, 0, .45); color: var(--med-text); }
.zl-msg-box svg { width: 28px; height: 28px; flex: none; fill: #f0a33a; }
.zl-msg-t { display: grid; gap: 4px; flex: 1; min-width: 0; }
.zl-msg-t strong { font-size: calc(.95rem * var(--fs, 1)); }
.zl-msg-t span { font-size: calc(1.05rem * var(--fs, 1)); font-weight: 700; letter-spacing: .02em; overflow-wrap: anywhere; }
.zl-msg-t small { font-size: calc(.72rem * var(--fs, 1)); color: var(--med-muted); }
.zl-msg-x { flex: none; width: 34px; height: 34px; border-radius: 50%; border: 1px solid var(--med-line); background: var(--med-surface);
  color: var(--med-text); font-size: 1.3rem; line-height: 1; cursor: pointer; }
.zl-msg-x:hover, .zl-msg-x:focus-visible { border-color: #f0a33a; outline: none; }
.zl-meter { margin: 10px 12px 0; display: grid; gap: 6px; }
.zl-det { margin: 10px 12px 0; border: 1px solid var(--med-line); border-radius: 12px; overflow: hidden; }
.zl-det table { width: 100%; border-collapse: collapse; font-size: calc(.82rem * var(--fs, 1)); }
.zl-det th, .zl-det td { padding: 8px 12px; text-align: right; border-bottom: 1px solid var(--med-line); white-space: nowrap; }
.zl-det th:first-child, .zl-det td:first-child { text-align: left; white-space: normal; }
.zl-det th { color: var(--med-muted); font-weight: 500; font-size: calc(.74rem * var(--fs, 1)); }
.zl-det tfoot td { font-weight: 700; border-bottom: 0; background: var(--med-surface); }
.zl-sw { display: inline-block; width: 22px; height: 12px; border-radius: 3px; margin-right: 10px; vertical-align: middle; }
.zl-sw.k-hc { background: var(--med-hc); } .zl-sw.k-hp { background: var(--med-hp); } .zl-sw.k-base { background: var(--med-base, var(--med-hc)); }
.zl-sw.k-hc.tb-blue { background: var(--med-hc-blue, var(--med-hc)); } .zl-sw.k-hp.tb-blue { background: var(--med-hp-blue, var(--med-hp)); }
.zl-sw.k-hc.tb-white { background: var(--med-hc-white, var(--med-hc)); } .zl-sw.k-hp.tb-white { background: var(--med-hp-white, var(--med-hp)); }
.zl-sw.k-hc.tb-red { background: var(--med-hc-red, var(--med-hc)); } .zl-sw.k-hp.tb-red { background: var(--med-hp-red, var(--med-hp)); }
.zl-sw.zl-sub { background: #f1f5f9; box-shadow: inset 0 0 0 1px #94a3b8; }
.zl-nav { display: flex; align-items: center; gap: 6px; flex-wrap: nowrap; min-width: 0; }
.zl-nav .hero-l { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.zl-btn { border: 1px solid var(--med-line); background: var(--med-surface); color: var(--med-text); border-radius: 999px;
  min-width: 30px; height: 28px; padding: 0 9px; font: inherit; font-size: calc(.95rem * var(--fs, 1)); line-height: 1; cursor: pointer; }
.zl-btn:hover:not([disabled]), .zl-btn:focus-visible { border-color: var(--med-blue); outline: none; }
.zl-btn[disabled] { opacity: .35; cursor: default; }
.zl-btn.zl-today { font-size: calc(.72rem * var(--fs, 1)); color: var(--med-blue); padding: 0 8px; flex: none; }
.zl-btn { flex: none; }
.zl-hours svg { height: 90px; }
.zl-hl { display: flex; justify-content: space-between; font-size: calc(.68rem * var(--fs, 1)); color: var(--med-muted); padding: 2px 2px 0; }
.zl-wait { font-size: calc(.78rem * var(--fs, 1)); color: var(--med-muted); padding: 10px 2px; }
.zl-row { display: flex; flex-wrap: wrap; gap: 6px; }
.zl-fold { display: grid; gap: 6px; }
.zl-fold-w { margin: 10px 12px 0; }
.zl-fold-h { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 10px; border: 1px solid var(--med-line); border-radius: 10px;
  background: transparent; color: var(--med-muted); font: inherit; font-size: calc(.78rem * var(--fs, 1)); cursor: pointer; text-align: left; }
.zl-fold-h:hover, .zl-fold-h:focus-visible { border-color: var(--med-blue); color: var(--med-text); outline: none; }
.zl-fold-h em { margin-left: auto; font-style: normal; font-weight: 700; color: var(--med-text); }
.zl-fold-c { display: inline-block; transition: transform .15s; font-size: 1.1em; line-height: 1; }
.zl-fold.open .zl-fold-c { transform: rotate(90deg); }
@media (prefers-reduced-motion: reduce) { .zl-fold-c { transition: none; } }
.zl-chip { flex: 1 1 auto; min-width: 92px; padding: 6px 10px; border-radius: 10px; border: 1px solid var(--med-line);
  background: var(--med-surface); display: flex; flex-direction: column; gap: 1px; }
.zl-chip span { font-size: calc(.7rem * var(--fs, 1)); color: var(--med-muted); white-space: nowrap; }
.zl-chip b { font-size: calc(.86rem * var(--fs, 1)); font-weight: 700; white-space: nowrap; }
.zl-chip.k-hc { border-color: color-mix(in srgb, var(--med-hc) 55%, var(--med-line)); }
.zl-chip.k-hp { border-color: color-mix(in srgb, var(--med-hp) 55%, var(--med-line)); }
.zl-chip.k-hc b { color: var(--med-hc-text, #8fb0f0); }
.zl-chip.k-hp b { color: var(--med-hp-text, #eaa070); }
ha-card.light .zl-chip.k-hc b { color: var(--med-hc-text, #2f5fb8); }
ha-card.light .zl-chip.k-hp b { color: var(--med-hp-text, #b35619); }
.zl-chip[class*="tb-"] span::before { content: ""; display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; vertical-align: middle; }
.zl-chip.tb-blue span::before { background: #3b82f6; }
.zl-chip.tb-white span::before { background: #f1f5f9; box-shadow: 0 0 0 1px #94a3b8; }
.zl-chip.tb-red span::before { background: #ef4444; }
</style>`;

/** Statistiques relues toutes les 5 minutes : l'index du jour, lui, suit l'état du capteur en direct. */
const ZL_RELOAD = 5 * 60000;
const ZL_TIMEOUT = 60000;

/** Lectures partagées entre toutes les cartes ZLinky de la page (tableau de bord et aperçu de l'éditeur) :
 *  une même demande n'est envoyée qu'une fois par période de validité. L'historique de Home Assistant traite
 *  les lectures une par une : des lectures en double font attendre toutes les cartes de statistiques. */
const ZL_SHARED = new Map();
const zlShared = (key, ttl, fn) => {
  const hit = ZL_SHARED.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.promise;
  const promise = fn();
  ZL_SHARED.set(key, { at: Date.now(), promise });
  promise.catch(() => { if (ZL_SHARED.get(key)?.promise === promise) ZL_SHARED.delete(key); });
  return promise;
};

/** Consommation par jour depuis le 1er janvier de l'an dernier. Les jours terminés ne changent plus : ils
 *  sont gardés par le navigateur, et seuls les derniers jours sont redemandés (lecture lourde une seule fois). */
const ZL_DAILY_KEEP = 2;
async function zlDaily(call, ids, yearStart) {
  const key = `zlinky-card:jours:v1:${ids.join(",")}`;
  const today = ZL.dayOf(new Date()).getTime();
  let kept = null;
  try { kept = JSON.parse(localStorage.getItem(key) || "null"); } catch (e) { kept = null; }
  const usable = kept && kept.from <= yearStart.getTime() && kept.rows && ids.every((id) => Array.isArray(kept.rows[id]));
  // reprise : quelques jours avant le dernier jour gardé (Home Assistant peut encore compléter les dernières heures)
  const from = usable ? new Date(Math.max(kept.from, kept.through - ZL_DAILY_KEEP * ZL.DAY)) : yearStart;
  const fresh = (await call(from, "day", ["change"], ids, { energy: "kWh" })) || {};
  const out = {};
  for (const id of ids) {
    const old = usable ? kept.rows[id].filter((r) => r.start < from.getTime()) : [];
    const recent = (fresh[id] || []).map((r) => ({ start: ZL.start(r).getTime(), change: r.change }));
    out[id] = [...old, ...recent].filter((r) => r.start >= yearStart.getTime());
  }
  // seuls les jours terminés sont gardés ; en cas de stockage plein ou indisponible, tout est relu la fois suivante
  try {
    const rows = Object.fromEntries(ids.map((id) => [id, out[id].filter((r) => r.start < today)]));
    localStorage.setItem(key, JSON.stringify({ from: yearStart.getTime(), through: today, rows }));
  } catch (e) { /* stockage indisponible */ }
  return out;
}

class ZlinkyCard extends LinkyLook {
  static getConfigElement() {
    return document.createElement("zlinky-card-editor");
  }

  /** Repère les index du LiXee. ZHA : tier1 à tier6 summation delivered (Tempo : HC bleu, HP bleu, HC blanc,
   *  HP blanc, HC rouge, HP rouge) ; Zigbee2MQTT : hchc / hchp, bbrhcjb … bbrhpjr, base. */
  static getStubConfig(hass) {
    const ids = zlEnergyIds(hass).filter((id) => /linky|lixee|teleinfo|tic/i.test(id));
    const pick = (re) => ids.find((id) => re.test(id)) || "";
    const tier = (n) => pick(new RegExp(`(tier_?${n}_summation|summation_delivered_tier_?${n}|tier_?${n}$)`, "i"));
    const all = Object.keys(hass?.states || {}).filter((id) => /linky|lixee|teleinfo|tic/i.test(id));
    const find = (re) => all.find((id) => re.test(id)) || "";
    // puissance apparente (ZHA apparent_power, Zigbee2MQTT SINSTS en mode standard, PAPP en mode historique)
    // et période en cours (LTARF en mode standard, PTEC en mode historique)
    const out = {
      power_entity: find(/apparent_power|sinsts|papp|puissance_apparente/i),
      tariff_entity: "",
      // courant, tension, puissance maximale du jour (SMAXSN, pas celle de la veille SMAXSN-1), qualité du lien Zigbee
      current_entity: find(/irms1?$|rms_current|_iinst$|courant/i),
      voltage_entity: find(/urms1?$|rms_voltage|tension/i),
      max_power_entity: find(/smaxsn$|smaxn$|pmax$/i),
      // puissance active moyenne sur 30 minutes (CCASN) et celle des 30 minutes précédentes (CCASN-1)
      ccasn_entity: find(/ccasn$/i),
      ccasn_prev_entity: find(/ccasn_?1$/i),
      // messages du fournisseur ou du distributeur affichés par le compteur (MSG1, MSG2)
      message_entity: find(/message_?1$|msg_?1$/i),
      message2_entity: find(/message_?2$|msg_?2$/i),
      lqi_entity: Object.keys(hass?.states || {}).find((id) => /(linky|lixee).*(linkquality|_lqi$)/i.test(id)) || "",
    };
    // Période en cours : le capteur dont l'état ressemble à « HP BLEU », « HCJB »… (Zigbee2MQTT nomme parfois
    // current_tarif le nom de l'option, TEMPO, et current_price la période en cours)
    const periods = all.filter((id) => /ltarf|ptec|tarif|price|periode/i.test(id));
    // ZHA : active_register_tier_delivered donne le numéro de l'index en cours (1 = HC, 2 = HP…)
    out.tariff_entity = periods.find((id) => /\bH[CP]|^H[CP]/i.test(String(hass.states[id]?.state || "")))
      || find(/ltarf|ptec/i) || find(/active_register_tier/i);
    // Zigbee2MQTT : mode historique (BBRHCJB…) ou mode standard (index nommés « HC BLEU »…)
    const z2m = {
      hc_blue: /bbrhcjb|hc_?bleu|hcjb/i, hp_blue: /bbrhpjb|hp_?bleu|hpjb/i,
      hc_white: /bbrhcjw|hc_?blanc|hcjw/i, hp_white: /bbrhpjw|hp_?blanc|hpjw/i,
      hc_red: /bbrhcjr|hc_?rouge|hcjr/i, hp_red: /bbrhpjr|hp_?rouge|hpjr/i,
    };
    // Zigbee2MQTT, mode standard : index fournisseur EASF01 à EASF06 (Tempo : HC bleu, HP bleu, HC blanc,
    // HP blanc, HC rouge, HP rouge ; HC/HP : EASF01 et EASF02 seulement, les suivants restent à 0) ; Base : EAST
    const easf = (n) => pick(new RegExp(`easf0?${n}$`, "i"));
    if (easf(1) && easf(2)) {
      const used = [3, 4, 5, 6].some((n) => Number(hass.states[easf(n)]?.state) > 0);
      if (used) {
        ZL_TEMPO_PARTS.forEach((p, i) => { out[p.conf] = easf(i + 1); });
        return out;
      }
      return { ...out, hc_entity: easf(1), hp_entity: easf(2) };
    }
    if (tier(6) || pick(z2m.hp_red)) {
      ZL_TEMPO_PARTS.forEach((p, i) => { out[p.conf] = tier(i + 1) || pick(z2m[p.key]); });
      return out;
    }
    const hc = tier(1) || pick(/hchc|_hc$|heures_creuses/i);
    const hp = tier(2) || pick(/hchp|_hp$|heures_pleines/i);
    if (hc && hp) return { ...out, hc_entity: hc, hp_entity: hp };
    return { ...out, base_entity: pick(/summation_delivered|_east$|base|index/i) };
  }

  setConfig(config) {
    const c = { ...ZL_DEFAULTS, ...(config || {}) };
    if (!ZL_TEMPO_PARTS.some((p) => c[p.conf]) && !(c.hc_entity && c.hp_entity) && !c.base_entity) {
      throw new Error("Indiquez les index du ZLinky : Tempo (hc_blue_entity … hp_red_entity), heures creuses et heures pleines (hc_entity, hp_entity), ou Base (base_entity).");
    }
    // Contrat Tempo : couleurs des jours affichées (pastilles du graphique, détail), sauf si coupé dans la configuration
    if (ZL_TEMPO_PARTS.some((p) => c[p.conf]) && !("show_tempo" in (config || {}))) c.show_tempo = true;
    this._config = { ...c, days: Number(c.days || ZL_DEFAULTS.days) };
    this._baseConfig = this._config;
    this._sig = null;
    // un réglage d'affichage ne relit pas les statistiques : seulement un changement des capteurs lus
    const dataKey = this._dataKey();
    if (dataKey !== this._lastDataKey) {
      this._lastDataKey = dataKey;
      this._selected = 0;
      this._stats = null;
      this._hours = {};
      this._loadedAt = 0;
    }
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
      this.shadowRoot.addEventListener("click", (ev) => {
        // sections rabattables (« En direct », « Index du compteur ») : état retenu par le navigateur
        const fold = ev.target.closest("[data-fold]");
        if (fold) {
          const k = fold.dataset.fold;
          // choix lié au réglage du moment : changer le réglage dans l'éditeur reprend la main
          this._folds = { ...this._folds, [k]: { open: !this._isOpen(k), cfg: this._config[`${k}_open`] !== false } };
          try { localStorage.setItem("zlinky-card:sections", JSON.stringify(this._folds)); } catch (e) { /* stockage indisponible */ }
          this._render(true);
          return;
        }
        // fermeture du message du compteur : il ne revient que si son texte change
        if (ev.target.closest("[data-msg-close]")) {
          this._msgClosed = this._msgText || "";
          if (!this._config.message_test) { try { localStorage.setItem("zlinky-card:message-ferme", this._msgClosed); } catch (e) { /* stockage indisponible */ } }
          this._render(true);
          return;
        }
        // ‹ › : jour précédent / suivant ; « Aujourd'hui » : retour au jour en cours
        const nav = ev.target.closest("[data-nav]");
        if (nav) {
          const max = Math.max(0, (this._all?.length || 1) - 1);
          const n = nav.dataset.nav;
          this._selected = n === "today" ? 0 : n === "prev" ? Math.min(max, this._selected + 1) : Math.max(0, this._selected - 1);
          this._render(true);
          this._loadHours();
          return;
        }
        const t = ev.target.closest("[data-i]");
        if (!t) return;
        this._selected = Number(t.dataset.i);
        this._render(true);
        this._loadHours();
      });
    }
    this._render(true);
  }

  set hass(hass) {
    this._hass = hass;
    if (this._baseConfig) this._config = withAliases(this._baseConfig, hass);
    if (!this._loading && Date.now() - this._loadedAt > ZL_RELOAD) this._load();
    this._render(false);
  }

  connectedCallback() {
    clearInterval(this._tick);
    this._tick = setInterval(() => { if (this._hass) this._load(); }, ZL_RELOAD);
  }

  disconnectedCallback() {
    clearInterval(this._tick);
  }

  /** Ce qui est lu dans l'historique : index, puissance, prix du tableau Énergie. */
  _dataKey() {
    const c = this._config;
    return JSON.stringify([this._parts().map((p) => p.id), c.show_power !== false ? c.power_entity : "",
      !!(c.show_cost && c.energy_prices !== false)]);
  }

  /** Index lus : Tempo (jusqu'à 6), sinon HC et HP, sinon Base. */
  _parts() {
    const c = this._config;
    const tempo = ZL_TEMPO_PARTS.filter((p) => c[p.conf]).map((p) => ({ ...p, id: c[p.conf] }));
    if (tempo.length) return tempo;
    if (c.hc_entity && c.hp_entity) return [{ key: "hc", kind: "hc", color: null, id: c.hc_entity }, { key: "hp", kind: "hp", color: null, id: c.hp_entity }];
    return [{ key: "base", kind: "base", color: null, id: c.base_entity }];
  }

  /** Statistiques par jour (depuis le 1er janvier de l'an dernier), par heure (hier et aujourd'hui),
   *  pic de puissance par jour, et prix du tableau Énergie. */
  async _load() {
    if (!this._hass || !this._config) return;
    this._loading = true;
    try {
      const now = new Date();
      const parts = this._parts();
      const list = parts.map((p) => p.id);
      const yearStart = new Date(now.getFullYear() - 1, 0, 1);
      const yesterday = new Date(ZL.dayOf(now).getTime() - ZL.DAY);
      // délai maximal : si l'historique de Home Assistant ne répond plus, la carte le dit et réessaie
      // au prochain cycle au lieu d'attendre indéfiniment
      const timed = (promise) => Promise.race([promise, new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Home Assistant ne répond pas (historique occupé), nouvel essai dans 5 minutes")), ZL_TIMEOUT))]);
      const call = (start, period, types, statistic_ids, units) => timed(
        this._hass.callWS({
          type: "recorder/statistics_during_period",
          start_time: start.toISOString(),
          end_time: now.toISOString(),
          statistic_ids,
          period,
          types,
          ...(units ? { units } : {}),
        }));
      // une lecture à la fois (pas en parallèle) : les autres cartes de statistiques passent entre deux
      const ttl = ZL_RELOAD - 30000;
      const ids = list.join(",");
      const daily = await zlShared(`jours|${ids}`, ttl, () => zlDaily(call, list, yearStart));
      const hourly = await zlShared(`heures|${ids}`, ttl, () => call(yesterday, "hour", ["change", "state"], list, { energy: "kWh" }));
      let power = null;
      const pw = this._config.power_entity;
      if (pw && this._config.show_power !== false) {
        const from = new Date(ZL.dayOf(now).getTime() - 31 * ZL.DAY);
        power = await zlShared(`pic|${pw}`, ttl, () => call(from, "day", ["max"], [pw])).catch(() => null);
      }
      let prefs = null;
      if (this._config.show_cost && this._config.energy_prices !== false) {
        prefs = await zlShared("prix", ttl, () => this._hass.callWS({ type: "energy/get_prefs" })).catch(() => null);
      }
      this._stats = { daily: daily || {}, hourly: hourly || {}, power: power?.[pw] || [], prefs, parts, at: now };
      this._error = null;
    } catch (e) {
      this._error = e?.message || String(e);
    }
    this._loading = false;
    this._loadedAt = Date.now();
    this._render(true);
  }

  _signature() {
    const c = this._config;
    const ids = [...this._parts().map((p) => p.id), c.power_entity, c.tariff_entity, c.current_entity, c.voltage_entity,
      c.max_power_entity, c.lqi_entity, c.ccasn_entity, c.ccasn_prev_entity, c.message_entity, c.message2_entity,
      c.tempo_today, c.tempo_tomorrow, c.ecowatt];
    ids.push(c.message_test ? "test" : "", this._msgClosed || "");
    return `${c.theme}|${this._hass?.themes?.darkMode}|${this._loadedAt}|` + ids.map((id) => this._state(id)?.last_updated || "-").join("|");
  }

  /** Jours, du plus récent (aujourd'hui, en direct) au plus ancien. Chaque jour garde la consommation de
   *  chaque index (parts) pour le coût, et sa couleur Tempo (index de la couleur qui a tourné ce jour-là). */
  _days() {
    const s = this._stats;
    const now = new Date();
    const today = ZL.dayOf(now);
    const byDay = new Map();
    const day = (k, date) => {
      if (!byDay.has(k)) byDay.set(k, { date, total: null, hc: null, hp: null, mp: null, mpTime: null, mpOver: false, tempo: null, offerCost: null, parts: {} });
      return byDay.get(k);
    };
    const add = (d, part, value) => {
      d.parts[part.key] = (d.parts[part.key] || 0) + value;
      if (part.kind === "base") d.total = (d.total || 0) + value;
      else d[part.kind] = (d[part.kind] || 0) + value;
    };
    for (const part of s.parts) {
      for (const row of s.daily[part.id] || []) {
        const d = ZL.dayOf(ZL.start(row));
        if (d >= today || !Number.isFinite(row.change)) continue;
        add(day(ZL.key(d), d), part, row.change);
      }
    }
    // Aujourd'hui : heures déjà enregistrées + écart entre l'index actuel et la dernière heure enregistrée
    const t = day(ZL.key(today), today);
    t.today = true;
    let sameTime = 0;
    const dayAgo = now.getTime() - ZL.DAY;
    // Index qui tourne en ce moment : écart depuis la dernière heure enregistrée, sinon consommation de cette heure-là
    let active = null, activeRate = 0;
    for (const part of s.parts) {
      let sum = 0, last = null;
      for (const row of s.hourly[part.id] || []) {
        const at = ZL.start(row);
        if (at >= today) { if (Number.isFinite(row.change)) sum += row.change; }
        else if (at.getTime() + 3600000 <= dayAgo && Number.isFinite(row.change)) sameTime += row.change;
        last = row;
      }
      const cur = ZL.kwh(this._state(part.id));
      const delta = cur !== null && last && Number.isFinite(last.state) ? Math.max(0, cur - last.state) : 0;
      if (delta && ZL.start(last).getTime() + 3600000 >= today.getTime()) sum += delta;
      const rate = delta || (last && Number.isFinite(last.change) ? last.change : 0);
      if (rate > activeRate) { activeRate = rate; active = part; }
      if (sum > 0 || part.kind !== "base" || !s.parts.some((p) => p.color)) add(t, part, sum);
    }
    this._yesterdaySameTime = sameTime;
    this._activePart = s.parts.length > 1 ? active : null;
    // Pic de puissance apparente par jour
    const unit = this._state(this._config.power_entity)?.attributes?.unit_of_measurement;
    const subPower = MED.num(this._config.subscribed_power);
    for (const row of s.power || []) {
      const d = ZL.dayOf(ZL.start(row));
      const mp = ZL.kva(row.max, unit);
      if (mp === null || !byDay.has(ZL.key(d))) continue;
      const x = byDay.get(ZL.key(d));
      x.mp = mp;
      x.mpOver = subPower ? mp > subPower : false;
    }
    const all = [...byDay.values()].sort((a, b) => b.date - a.date);
    all.forEach((d) => {
      if (d.total === null && d.hc !== null && d.hp !== null) d.total = d.hc + d.hp;
      // Couleur Tempo du jour : celle dont les index ont le plus tourné
      let best = 0;
      for (const part of s.parts) {
        const v = d.parts[part.key] || 0;
        if (part.color && v > best) { best = v; d.tempo = part.color; }
      }
    });
    // Aujourd'hui : la période en cours du ZLinky (HPJB…) fait foi, le jour Tempo commençant à 6 h
    t.tempo = this._activePart?.color || zlColor(this._state(this._config.tariff_entity)?.state) || t.tempo;
    return all;
  }

  /** Totaux et comparaisons jusqu'à hier (jours complets), au format des attributs de MyElectricalData :
   *  les cases les reprennent telles quelles. Une période de comparaison n'est retenue que si les statistiques
   *  la couvrent presque entièrement (au moins 90 % des jours) : pas de « 0 kWh » ni de « +88 % » trompeurs. */
  _aggregates(all) {
    const now = new Date();
    const today = new Date(ZL.dayOf(now).getTime() - ZL.DAY); // hier : dernier jour complet
    const sum = (from, to, cover = 0) => {
      const sel = all.filter((d) => !d.today && d.total !== null && d.date >= from && d.date <= to);
      const span = Math.round((ZL.dayOf(to) - ZL.dayOf(from)) / ZL.DAY) + 1;
      if (!sel.length || sel.length < cover * span) return null;
      return sel.reduce((t, d) => t + d.total, 0);
    };
    const monday = new Date(today.getTime() - ((today.getDay() + 6) % 7) * ZL.DAY);
    const y = now.getFullYear(), m = now.getMonth();
    const lastDayLy = new Date(y - 1, today.getMonth(), today.getDate());
    const evo = (cur, ref) => (cur !== null && ref ? ((cur - ref) / ref) * 100 : null);
    const lm = sum(new Date(y, m - 1, 1), new Date(y, m, 0));
    const lmLy = sum(new Date(y - 1, m - 1, 1), new Date(y - 1, m, 0), 0.9);
    const cy = sum(new Date(y, 0, 1), today);
    const cyLy = sum(new Date(y - 1, 0, 1), lastDayLy, 0.9);
    const last30 = all.filter((d) => !d.today && d.hc !== null && d.hp !== null).slice(0, 30);
    const hcs = last30.reduce((t, d) => t + d.hc, 0), hps = last30.reduce((t, d) => t + d.hp, 0);
    return {
      current_week: sum(monday, today),
      last_week: sum(new Date(monday.getTime() - 7 * ZL.DAY), new Date(monday.getTime() - ZL.DAY)),
      current_month: sum(new Date(y, m, 1), today),
      current_month_last_year: sum(new Date(y - 1, m, 1), new Date(y - 1, m + 1, 0), 0.9),
      last_month: lm,
      last_month_last_year: lmLy,
      monthly_evolution: evo(lm, lmLy),
      current_year: cy,
      current_year_last_year: cyLy,
      yearly_evolution: evo(cy, cyLy),
      peak_offpeak_percent: hcs + hps > 0 ? (hps / (hcs + hps)) * 100 : null,
    };
  }

  /** Prix de chaque index : saisi dans la carte (HC, HP, Base) d'abord, puis tableau Énergie, puis, pour Tempo,
   *  les capteurs de prix Tempo (price_prefix, comme la carte Enedis Linky New). */
  _partPrices() {
    const c = this._config;
    const manual = manualPrices(c);
    const prefs = c.energy_prices !== false ? this._stats?.prefs : null;
    const out = {};
    const used = new Set();
    for (const part of this._stats.parts) {
      let price = null, from = null;
      if (manual && !part.color) {
        price = part.kind === "base" ? manual.base : manual[part.kind];
        from = "card";
      }
      if (price === null && prefs) { price = ZL.energyPrice(prefs, part.id, this._hass); from = "energy"; }
      if (price === null && part.color) {
        price = MED.num(this._state(`${c.price_prefix}${part.color}_${part.kind}`)?.state);
        from = "tempo";
      }
      out[part.key] = price;
      if (price !== null) used.add(from);
    }
    this._priceSource = [...used];
    return out;
  }

  /** Coût d'un jour : somme des index × leur prix ; inconnu si un index qui a tourné n'a pas de prix. */
  _partCost(d, prices) {
    let cost = 0, any = false;
    for (const part of this._stats.parts) {
      const v = d.parts[part.key];
      if (!v) continue;
      if (prices[part.key] === null || prices[part.key] === undefined) return null;
      cost += v * prices[part.key];
      any = true;
    }
    return any ? cost : d.total === 0 ? 0 : null;
  }

  _render(force) {
    if (!this._config || !this._hass || !this.shadowRoot) return;
    const sig = this._signature();
    if (!force && sig === this._sig) return;
    this._sig = sig;
    const c = this._config;
    const mode = themeClass(c.theme, this._hass);
    const missing = this._parts().map((p) => p.id).filter((id) => !this._state(id));
    if (missing.length) {
      // index du ZLinky trouvés dans Home Assistant, pour aider à choisir
      const found = zlEnergyIds(this._hass).filter((id) => /linky|lixee|teleinfo|tic/i.test(id)).slice(0, 12);
      this.shadowRoot.innerHTML = `${STYLE}<ha-card class="${mode}"><div class="empty">
        <strong>Entité introuvable : ${esc(missing.join(", "))}</strong>
        <span>Choisissez les index du ZLinky dans l'éditeur de la carte : Tempo (6 index), heures creuses et heures pleines, ou Base.</span>
        ${found.length ? `<span>Index trouvés : ${found.map((id) => `<code>${esc(id)}</code>`).join(", ")}</span>` : ""}</div></ha-card>`;
      return;
    }
    if (!this._stats) {
      this.shadowRoot.innerHTML = `${STYLE}<ha-card class="${mode}"><div class="empty">
        <strong>${this._error ? "Statistiques illisibles" : "Lecture des statistiques…"}</strong>
        ${this._error ? `<span>${esc(this._error)}</span>` : ""}</div></ha-card>`;
      return;
    }
    const all = this._days();
    const a = this._aggregates(all);
    const base = all.some((d) => d.total !== null) && !all.some((d) => d.hc !== null && d.hp !== null);
    this._base = base;
    const prices = c.show_cost ? this._partPrices() : null;
    const sub = c.show_cost ? positivePrice(c.subscription_price) : null;
    this._subscription = sub;
    all.forEach((d) => {
      d.est = null;
      d.costEst = null;
      d.cost = prices ? this._partCost(d, prices) : null;
      if (sub !== null && d.date) {
        const full = sub / new Date(d.date.getFullYear(), d.date.getMonth() + 1, 0).getDate();
        // aujourd'hui : abonnement au prorata de l'heure
        d.sub = d.today ? (full * (Date.now() - d.date.getTime())) / ZL.DAY : full;
        if (d.cost !== null) d.cost += d.sub;
      }
    });
    const shown = all.slice(0, Math.max(1, Math.min(c.days, all.length)));
    this._all = all;
    if (this._selected >= all.length) this._selected = 0;
    this.shadowRoot.innerHTML = `${STYLE}${ZL_STYLE}<ha-card class="${mode}"${hcHpStyle(c)}>
      ${this._message()}
      ${this._header(null)}
      ${this._zlHero(all[this._selected], all[this._selected + 1])}
      ${this._hoursChart(all[this._selected])}
      ${c.show_details !== false ? this._details(all[this._selected], prices) : ""}
      ${c.show_meter !== false ? this._meter(prices) : ""}
      ${c.show_totals === false ? "" : this._fold("totals", "Semaine, mois et année",
        [a.current_month !== null ? `${cap(new Date().toLocaleDateString("fr-FR", { month: "long" }))} ${fmt(a.current_month, 0)} kWh` : "",
          a.current_year !== null ? `Année ${fmt(a.current_year, 0)} kWh` : ""].filter(Boolean).join(" · "),
        this._tiles(a, all.filter((d) => !d.today)))}
      ${c.show_chart === false ? "" : this._fold("chart", "Historique",
        `${shown.length} jours · ${fmt(shown.reduce((t, d) => t + (d.total || 0), 0), 0)} kWh`, this._chart(shown))}
      ${c.show_power !== false ? this._power(shown) : ""}
      ${this._ecowatt()}
      ${this._zlFooter(all[1])}
    </ha-card>`;
  }

  /** Aujourd'hui, en direct, comparé à hier à la même heure. */
  _zlHero(day, prev) {
    if (!day) return "";
    const live = !!day.today;
    // aujourd'hui : écart avec hier à la même heure ; jour passé : écart avec la veille
    const ref = live ? this._yesterdaySameTime : prev?.total;
    const evo = day.total !== null && ref > 0 ? ((day.total - ref) / ref) * 100 : null;
    const split = day.hc !== null && day.hp !== null && day.hc + day.hp > 0;
    const hcPct = split ? (day.hc / (day.hc + day.hp)) * 100 : 0;
    const when = day.date.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
    return `<section class="hero">
      <div>
        <div class="zl-nav">
          <button class="zl-btn" data-nav="prev" title="Jour précédent" aria-label="Jour précédent"${this._selected >= (this._all?.length || 1) - 1 ? " disabled" : ""}>‹</button>
          <span class="hero-l" title="${esc(cap(when))}">${esc(cap(live ? when : day.date.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" })))}${live ? " · en cours" : ""}</span>
          <button class="zl-btn" data-nav="next" title="Jour suivant" aria-label="Jour suivant"${live ? " disabled" : ""}>›</button>
          ${live ? "" : `<button class="zl-btn zl-today" data-nav="today">Aujourd'hui</button>`}
        </div>
        <div class="hero-v">${fmt(day.total, 2)}<span>kWh</span></div>
        ${evo !== null ? `<div class="evo ${evo > 0 ? "up" : "down"}">${evo > 0 ? "+" : ""}${fmt(evo, 1)} % ${live ? "par rapport à hier à la même heure" : "par rapport à la veille"}</div>` : ""}
        ${prev && prev.total !== null ? `<div class="hero-p">${live ? "Hier" : "Veille"} : ${fmt(prev.total, 2)} kWh${prev.cost !== null && prev.cost !== undefined ? ` · ${euro(prev.cost)}` : ""}</div>` : ""}
      </div>
      <div class="hero-r">
        ${!this._config.show_cost ? "" : day.cost !== null
          ? `<div class="cost">${euro(day.cost)}</div><div class="cost-l">${live ? "coût depuis minuit" : "coût de la journée"}${day.sub ? `, dont abonnement ${euro(day.sub)}` : ""}</div>`
          : `<div class="cost none">—</div><div class="cost-l">prix introuvables (tableau Énergie ou carte)</div>`}
        ${live ? this._livePower() + this._tariff() : day.mp !== null ? `<div class="hero-p">Pic ${fmt(day.mp, 2)} kVA${day.mpOver ? " · dépassement" : ""}</div>` : ""}
      </div>
      ${split
        ? `<div class="split${TEMPO[day.tempo] ? ` tb-${day.tempo}` : ""}"><div class="bar"><i class="hc" style="width:${hcPct}%"></i><i class="hp" style="width:${100 - hcPct}%"></i></div>
           <div class="split-l"><span class="k-hc">Heures creuses ${fmt(day.hc, 2)} kWh</span><span class="k-hp">Heures pleines ${fmt(day.hp, 2)} kWh</span></div></div>`
        : ""}
    </section>`;
  }

  /** Message du fournisseur ou du distributeur (MSG1, MSG2 du compteur), en fenêtre sur la carte.
   *  « PAS DE MESSAGE » et les valeurs vides sont ignorés ; message_test affiche un exemple (essai depuis l'éditeur). */
  _message() {
    const c = this._config;
    if (c.show_messages === false && !c.message_test) return "";
    const clean = (id) => {
      const v = String(this._state(id)?.state ?? "").trim();
      return !v || /^(unknown|unavailable|none|pas de message)$/i.test(v) ? "" : v;
    };
    const lines = c.message_test
      ? ["Message d'essai de la carte ZLinky", "Ex. : POINTE MOBILE DEMAIN"]
      : [clean(c.message_entity), clean(c.message2_entity)].filter(Boolean);
    this._msgText = lines.join(" · ");
    if (!lines.length) return "";
    if (this._msgClosed === undefined) {
      try { this._msgClosed = localStorage.getItem("zlinky-card:message-ferme") || ""; } catch (e) { this._msgClosed = ""; }
    }
    if (this._msgClosed === this._msgText) return "";
    return `<div class="zl-msg" role="alertdialog" aria-label="Message du compteur">
      <div class="zl-msg-box">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm-7 12h-2v-2h2v2zm0-4h-2V6h2v4z"/></svg>
        <div class="zl-msg-t">
          <strong>${c.message_test ? "Essai : message du compteur" : "Message du compteur"}</strong>
          ${lines.map((l) => `<span>${esc(l)}</span>`).join("")}
          <small>Envoyé par le fournisseur ou le distributeur et affiché sur le Linky.</small>
        </div>
        <button class="zl-msg-x" data-msg-close title="Fermer" aria-label="Fermer le message">×</button>
      </div>
    </div>`;
  }

  /** Détail du jour, comme le tableau Énergie : une ligne par index (énergie et coût), l'abonnement, puis le total. */
  _details(day, prices) {
    if (!day || !this._stats) return "";
    const rows = [];
    for (const part of this._stats.parts) {
      const v = day.parts?.[part.key] || 0;
      // en Tempo, seuls les index qui ont tourné ce jour-là ; en HC/HP et Base, toujours
      if (!v && part.color) continue;
      const price = prices ? prices[part.key] : null;
      const name = part.kind === "base" ? "Base" : `${part.kind === "hc" ? "Heures creuses" : "Heures pleines"}${part.color ? ` · ${TEMPO[part.color].label}` : ""}`;
      rows.push(`<tr><td><i class="zl-sw k-${part.kind}${part.color ? ` tb-${part.color}` : ""}"></i>${esc(name)}</td>
        <td>${fmt(v, 2)} kWh</td><td>${price !== null && price !== undefined ? euro(v * price) : "—"}</td></tr>`);
    }
    if (day.sub) rows.push(`<tr><td><i class="zl-sw zl-sub"></i>Abonnement${day.today ? " (au prorata de l'heure)" : ""}</td><td>0 kWh</td><td>${euro(day.sub)}</td></tr>`);
    if (!rows.length) return "";
    return `<section class="zl-det">
      <table>
        <thead><tr><th>Source</th><th>Énergie</th><th>Coût</th></tr></thead>
        <tbody>${rows.join("")}</tbody>
        <tfoot><tr><td>Total</td><td>${fmt(day.total, 2)} kWh</td><td>${day.cost !== null && day.cost !== undefined ? euro(day.cost) : "—"}</td></tr></tfoot>
      </table>
    </section>`;
  }

  /** Consommation heure par heure du jour affiché : hier et aujourd'hui sont déjà lus, les autres jours à la demande. */
  async _loadHours() {
    const d = this._all?.[this._selected];
    if (!d || !this._hass || !this._stats) return;
    const key = ZL.key(d.date);
    this._hours = this._hours || {};
    if (this._hours[key] || d.today || d.date.getTime() === ZL.dayOf(new Date()).getTime() - ZL.DAY) return;
    this._hours[key] = "loading";
    try {
      this._hours[key] = await this._hass.callWS({
        type: "recorder/statistics_during_period",
        start_time: d.date.toISOString(),
        end_time: new Date(d.date.getTime() + ZL.DAY).toISOString(),
        statistic_ids: this._stats.parts.map((p) => p.id),
        period: "hour",
        types: ["change"],
        units: { energy: "kWh" },
      });
    } catch (e) {
      delete this._hours[key];
    }
    this._render(true);
  }

  _hoursChart(day) {
    if (!day || !this._stats) return "";
    const start = day.date.getTime();
    const recent = day.today || start === ZL.dayOf(new Date()).getTime() - ZL.DAY;
    const src = recent ? this._stats.hourly : this._hours?.[ZL.key(day.date)];
    if (!src || src === "loading") return `<section class="zl-hours"><div class="chart-h"><span>Heure par heure</span></div><div class="zl-wait">Lecture…</div></section>`;
    const hours = Array.from({ length: 24 }, () => ({ hc: 0, hp: 0, base: 0, color: null, top: 0 }));
    for (const part of this._stats.parts) {
      for (const row of src[part.id] || []) {
        const t = ZL.start(row).getTime();
        if (t < start || t >= start + ZL.DAY || !Number.isFinite(row.change)) continue;
        const h = hours[Math.floor((t - start) / 3600000)];
        if (!h) continue;
        h[part.kind] += row.change;
        if (part.color && row.change > h.top) { h.top = row.change; h.color = part.color; }
      }
    }
    const max = Math.max(0.05, ...hours.map((h) => h.hc + h.hp + h.base)) * 1.08;
    const H = 100, slot = 100 / 24, w = slot * 0.7;
    const bars = hours.map((h, k) => {
      const x = k * slot + (slot - w) / 2;
      const tb = h.color && TEMPO[h.color] ? ` tb-${h.color}` : "";
      const hHc = (h.hc / max) * H, hHp = (h.hp / max) * H, hB = (h.base / max) * H;
      const tip = `<title>${k} h - ${k + 1} h : ${fmt(h.hc + h.hp + h.base, 2)} kWh${h.hc || h.hp ? ` (HC ${fmt(h.hc, 2)}, HP ${fmt(h.hp, 2)})` : ""}</title>`;
      return `<g>${tip}${hB ? `<rect class="base" x="${x}" y="${H - hB}" width="${w}" height="${hB}"/>` : ""}
        ${hHc ? `<rect class="hc${tb}" x="${x}" y="${H - hHc}" width="${w}" height="${hHc}"/>` : ""}
        ${hHp ? `<rect class="hp${tb}" x="${x}" y="${H - hHc - hHp}" width="${w}" height="${hHp}"/>` : ""}</g>`;
    }).join("");
    const top = hours.reduce((m, h, k) => (h.hc + h.hp + h.base > m.v ? { v: h.hc + h.hp + h.base, k } : m), { v: 0, k: 0 });
    return `<section class="chart zl-hours">
      <div class="chart-h"><span>Heure par heure${top.v ? ` · maximum ${fmt(top.v, 2)} kWh de ${top.k} h à ${top.k + 1} h` : ""}</span></div>
      <svg viewBox="0 0 100 ${H}" preserveAspectRatio="none" role="img" aria-label="Consommation heure par heure">${bars}</svg>
      <div class="zl-hl"><span>0 h</span><span>6 h</span><span>12 h</span><span>18 h</span><span>24 h</span></div>
    </section>`;
  }

  /** Compteur en direct, comme l'ancien tableau de bord : puissance, courant, tension, pic du jour, tarif en cours
   *  et son prix, index (un par couleur et HC/HP en Tempo), total et part des heures creuses, qualité du lien. */
  _meter(prices) {
    const c = this._config;
    const num = (id) => { const v = Number(this._state(id)?.state); return Number.isFinite(v) ? v : null; };
    const unit = (id, d) => this._state(id)?.attributes?.unit_of_measurement || d;
    const chip = (label, value, cls = "", title = "") =>
      `<div class="zl-chip ${cls}"${title ? ` title="${esc(title)}"` : ""}><span>${esc(label)}</span><b>${value}</b></div>`;
    const live = [];
    const pw = this._state(c.power_entity);
    if (pw) live.push(chip("Puissance", `${fmt(num(c.power_entity), 0)} ${esc(unit(c.power_entity, "VA"))}`));
    if (this._state(c.current_entity)) live.push(chip("Courant", `${fmt(num(c.current_entity), 0)} ${esc(unit(c.current_entity, "A"))}`));
    if (this._state(c.voltage_entity)) live.push(chip("Tension", `${fmt(num(c.voltage_entity), 0)} ${esc(unit(c.voltage_entity, "V"))}`));
    if (this._state(c.max_power_entity)) live.push(chip("Pic du jour", `${fmt(num(c.max_power_entity), 0)} ${esc(unit(c.max_power_entity, "VA"))}`));
    // puissance active moyenne de la demi-heure (CCASN) et de la précédente (CCASN-1), chacune avec son interrupteur
    if (c.show_ccasn !== false && this._state(c.ccasn_entity)) {
      live.push(chip("Puissance (30 min)", `${fmt(num(c.ccasn_entity), 0)} ${esc(unit(c.ccasn_entity, "W"))}`, "", "Puissance active moyenne de la demi-heure en cours (CCASN)"));
    }
    if (c.show_ccasn_prev !== false && this._state(c.ccasn_prev_entity)) {
      live.push(chip("30 min précédentes", `${fmt(num(c.ccasn_prev_entity), 0)} ${esc(unit(c.ccasn_prev_entity, "W"))}`, "", "Puissance active moyenne de la demi-heure précédente (CCASN-1)"));
    }
    // tarif en cours et son prix (index de la période en cours)
    const period = this._period();
    const pPrice = period && period.part && prices ? prices[period.part.key] : null;
    const tariffTxt = period ? `${esc(period.label)}${pPrice !== null && pPrice !== undefined ? ` · ${fmt(pPrice, 4)} €` : ""}` : "";
    if (period) live.push(chip("Tarif", tariffTxt, period.kind ? `k-${period.kind}` : "", period.note));
    // index en kWh
    const idx = this._stats.parts.map((p) => ({ p, v: ZL.kwh(this._state(p.id)) })).filter((x) => x.v !== null);
    const name = (p) => (p.kind === "base" ? "Index" : `Index ${p.kind.toUpperCase()}${p.color ? ` ${TEMPO[p.color].label.toLowerCase()}` : ""}`);
    const index = idx.map(({ p, v }) => chip(name(p), `${fmt(v, 0)} kWh`, `k-${p.kind}${p.color ? ` tb-${p.color}` : ""}`, p.id));
    const total = idx.reduce((t, x) => t + x.v, 0);
    const hc = idx.filter((x) => x.p.kind === "hc").reduce((t, x) => t + x.v, 0);
    if (idx.length > 1) index.push(chip("Total", `${fmt(total, 0)} kWh`));
    if (idx.some((x) => x.p.kind === "hc") && total > 0) index.push(chip("Part HC (index)", `${fmt((hc / total) * 100, 1)} %`, "k-hc"));
    if (this._state(c.lqi_entity)) live.push(chip("Zigbee", `${fmt(num(c.lqi_entity), 0)} LQI`));
    if (!live.length && !index.length) return "";
    const section = (key, title, chips, summary) => {
      if (!chips.length || c[`show_${key}`] === false) return "";
      const open = this._isOpen(key);
      return `<div class="zl-fold${open ? " open" : ""}">
        <button class="zl-fold-h" data-fold="${key}" aria-expanded="${open}">
          <span class="zl-fold-c" aria-hidden="true">›</span><span>${title}</span>${open ? "" : `<em>${summary}</em>`}
        </button>
        ${open ? `<div class="zl-row">${chips.join("")}</div>` : ""}
      </div>`;
    };
    // résumé affiché quand la section est rabattue
    const liveSum = [pw ? `${fmt(num(c.power_entity), 0)} ${esc(unit(c.power_entity, "VA"))}` : "", tariffTxt].filter(Boolean).join(" · ");
    const indexSum = idx.length > 1 ? `Total ${fmt(total, 0)} kWh` : idx.length ? `${fmt(idx[0].v, 0)} kWh` : "";
    return `<section class="zl-meter">
      ${section("live", "En direct", live, liveSum)}
      ${section("index", "Index du compteur", index, indexSum)}
    </section>`;
  }

  /** Section rabattable autour d'un bloc de la carte (cases, graphique) ; rabattue, elle garde un résumé. */
  _fold(key, title, summary, html) {
    const open = this._isOpen(key);
    return `<div class="zl-fold zl-fold-w${open ? " open" : ""}">
      <button class="zl-fold-h" data-fold="${key}" aria-expanded="${open}">
        <span class="zl-fold-c" aria-hidden="true">›</span><span>${esc(title)}</span>${open ? "" : `<em>${summary}</em>`}
      </button>
    </div>${open ? html : ""}`;
  }

  /** Section ouverte : choix fait sur la carte (retenu par le navigateur), sinon réglage de la carte. */
  _isOpen(key) {
    if (this._folds === undefined) {
      try { this._folds = JSON.parse(localStorage.getItem("zlinky-card:sections") || "{}") || {}; } catch (e) { this._folds = {}; }
    }
    const cfg = this._config[`${key}_open`] !== false;
    const saved = this._folds[key];
    // choix fait sur la carte, tant que le réglage n'a pas changé depuis (ancien format booléen : ignoré)
    if (saved && typeof saved === "object" && saved.cfg === cfg) return !!saved.open;
    return cfg;
  }

  /** Période en cours. Le capteur du ZLinky fait foi : texte (LTARF, PTEC : « HP BLEU », « HC.. ») ou numéro de
   *  l'index en cours (ZHA, active_register_tier_delivered : 1 = HC, 2 = HP ; en Tempo 1 à 6 dans l'ordre des index).
   *  L'index qui a bougé le plus récemment ne l'emporte que si le capteur semble figé (LTARF parfois bloqué côté
   *  Zigbee) : son propre index n'a pas bougé depuis 20 minutes alors qu'un autre tourne. */
  _period() {
    const parts = this._stats.parts;
    const raw = this._state(this._config.tariff_entity)?.state;
    const text = raw && !["unknown", "unavailable", "none", ""].includes(String(raw).toLowerCase()) ? String(raw).trim() : null;
    const kindOf = (v) => (/^\s*hc|heures?\s*creuses|\bhc\b/i.test(v) ? "hc" : /^\s*hp|heures?\s*pleines|\bhp\b/i.test(v) ? "hp" : null);
    const labelOf = (p) => (p.kind === "base" ? "BASE" : `${p.kind.toUpperCase()}${p.color ? ` ${TEMPO[p.color].label.toUpperCase()}` : ""}`);
    // index annoncé par le capteur
    let said = null;
    if (text) {
      const tier = /^(?:tier\s*)?([1-9])$/i.exec(text);
      if (tier) said = parts[Number(tier[1]) - 1] || null;
      else {
        const kind = kindOf(text), color = zlColor(text);
        said = parts.find((p) => p.kind === kind && (!p.color || !color || p.color === color)) || null;
      }
    }
    // index qui tourne : dernier changement d'état, s'il est récent et seul en tête
    const changed = (p) => Date.parse(this._state(p.id)?.last_changed || "") || 0;
    const now = Date.now(), FRESH = 20 * 60000;
    const byRecent = parts.filter((p) => p.kind !== "base").map((p) => ({ p, t: changed(p) })).sort((x, y) => y.t - x.t);
    const moving = byRecent.length > 1 && byRecent[0].t > byRecent[1].t && now - byRecent[0].t < FRESH ? byRecent[0].p : null;
    let part = said, note = "";
    if (moving && (!said || (moving !== said && now - changed(said) > FRESH))) {
      part = moving;
      if (text) note = `d'après les index (le ZLinky indique ${text})`;
    } else if (!said && !text) {
      part = this._activePart && this._activePart.kind !== "base" ? this._activePart : null;
    }
    // libellé lisible : les points de remplissage du ZLinky sont retirés (« HC.. » → « HC »)
    const clean = (v) => v.replace(/[.\s]+$/, "").replace(/\.{2,}/g, " ").trim() || v;
    if (!part) return text ? { label: clean(text), kind: kindOf(text), part: null, note: "" } : null;
    // libellé : le texte du ZLinky s'il correspond, sinon le nom de l'index (un numéro ZHA n'est pas parlant)
    const keepText = text && part === said && kindOf(text) === part.kind;
    return { label: keepText ? clean(text) : labelOf(part), kind: part.kind === "base" ? null : part.kind, part, note };
  }

  /** Période tarifaire en cours, affichée sous la puissance. */
  _tariff() {
    const p = this._period();
    return p ? `<div class="hero-p"${p.note ? ` title="${esc(p.note)}"` : ""}>Période : ${esc(p.label)}</div>` : "";
  }

  /** Pastilles Tempo : accepte aussi les couleurs écrites par le ZLinky (BLEU, BLAN, ROUG). */
  _pill(entity, label) {
    let st = this._state(entity);
    // sans capteur RTE pour aujourd'hui : couleur de la période en cours du ZLinky
    if (!st && label === "Aujourd'hui") { st = this._state(this._config.tariff_entity); entity = this._config.tariff_entity; }
    const t = st ? TEMPO[zlColor(st.state)] : null;
    return `<div class="pill ${t ? t.cls : "t-none"}" title="${esc(entity)}">
      <span class="dot"></span><span class="pill-l">${label}</span>
      <span class="pill-v">${t ? t.label : "Non publié"}</span></div>`;
  }

  _livePower() {
    const st = this._state(this._config.power_entity);
    if (!st) return "";
    const kva = ZL.kva(st.state, st.attributes?.unit_of_measurement);
    return kva !== null ? `<div class="hero-p">Puissance actuelle ${fmt(kva, 2)} kVA</div>` : "";
  }

  _zlFooter(yesterday) {
    const bits = ["Données du ZLinky en direct (statistiques Home Assistant)"];
    if (this._config.show_cost) {
      const abo = this._subscription ? `abonnement compris (${euro(this._subscription)}/mois)` : "hors abonnement";
      const src = { card: "saisi dans la carte", energy: "du tableau Énergie", tempo: "Tempo du jour" };
      const from = (this._priceSource || []).map((k) => src[k]).filter(Boolean);
      bits.push(!from.length || (yesterday && yesterday.total && yesterday.cost === null)
        ? "prix introuvables pour certains index, coûts masqués"
        : `coûts estimés ${abo}, au prix ${from.join(" et ")}`);
    }
    return `<footer>${bits.join(", ")}.</footer>`;
  }
}

/* --------------------------------------------------------------- éditeur */

const ZL_SCHEMA = [
  { name: "hc_entity", selector: { entity: { domain: "sensor" } } },
  { name: "hp_entity", selector: { entity: { domain: "sensor" } } },
  { name: "base_entity", selector: { entity: { domain: "sensor" } } },
  ...ZL_TEMPO_PARTS.map((p) => ({ name: p.conf, selector: { entity: { domain: "sensor" } } })),
  { name: "power_entity", selector: { entity: { domain: "sensor" } } },
  { name: "tariff_entity", selector: { entity: { domain: "sensor" } } },
  { name: "current_entity", selector: { entity: { domain: "sensor" } } },
  { name: "voltage_entity", selector: { entity: { domain: "sensor" } } },
  { name: "max_power_entity", selector: { entity: { domain: "sensor" } } },
  { name: "lqi_entity", selector: { entity: { domain: "sensor" } } },
  { name: "ccasn_entity", selector: { entity: { domain: "sensor" } } },
  { name: "show_ccasn", selector: { boolean: {} } },
  { name: "ccasn_prev_entity", selector: { entity: { domain: "sensor" } } },
  { name: "show_ccasn_prev", selector: { boolean: {} } },
  { name: "message_entity", selector: { entity: { domain: "sensor" } } },
  { name: "message2_entity", selector: { entity: { domain: "sensor" } } },
  { name: "show_messages", selector: { boolean: {} } },
  { name: "message_test", selector: { boolean: {} } },
  { name: "title", selector: { text: {} } },
  SCHEMA.find((s) => s.name === "days"),
  { name: "subscribed_power", selector: { number: { min: 3, max: 36, step: 3, mode: "box", unit_of_measurement: "kVA" } } },
  { name: "show_meter", selector: { boolean: {} } },
  { name: "show_details", selector: { boolean: {} } },
  { name: "show_live", selector: { boolean: {} } },
  { name: "live_open", selector: { boolean: {} } },
  { name: "show_index", selector: { boolean: {} } },
  { name: "index_open", selector: { boolean: {} } },
  { name: "show_totals", selector: { boolean: {} } },
  { name: "totals_open", selector: { boolean: {} } },
  { name: "show_chart", selector: { boolean: {} } },
  { name: "chart_open", selector: { boolean: {} } },
  { name: "show_cost", selector: { boolean: {} } },
  { name: "energy_prices", selector: { boolean: {} } },
  { name: "subscription_price", selector: { number: { min: 0, max: 200, step: 0.01, mode: "box", unit_of_measurement: "€/mois" } } },
  { name: "hc_price", selector: { number: { min: 0, max: 2, step: 0.0001, mode: "box", unit_of_measurement: "€/kWh" } } },
  { name: "hp_price", selector: { number: { min: 0, max: 2, step: 0.0001, mode: "box", unit_of_measurement: "€/kWh" } } },
  { name: "base_price", selector: { number: { min: 0, max: 2, step: 0.0001, mode: "box", unit_of_measurement: "€/kWh" } } },
  SCHEMA.find((s) => s.name === "theme"),
  { name: "show_tempo", selector: { boolean: {} } },
  { name: "show_ecowatt", selector: { boolean: {} } },
  { name: "show_week", selector: { boolean: {} } },
  { name: "tiles_horizontal", selector: { boolean: {} } },
  { name: "show_power", selector: { boolean: {} } },
  SCHEMA.find((s) => s.name === "font_size"),
  { name: "tempo_today", selector: { entity: { domain: "sensor" } } },
  { name: "tempo_tomorrow", selector: { entity: { domain: "sensor" } } },
  { name: "tempo_info", selector: { entity: { domain: "sensor" } } },
  { name: "ecowatt", selector: { entity: { domain: "sensor" } } },
].filter(Boolean);

const ZL_LABELS = {
  ...LABELS,
  hc_entity: "Index heures creuses du ZLinky (kWh ou Wh ; contrat HC/HP)",
  hp_entity: "Index heures pleines du ZLinky (kWh ou Wh)",
  base_entity: "Index Base du ZLinky (seulement sans heures creuses / pleines)",
  power_entity: "Puissance apparente du ZLinky (VA, facultatif : pic par jour et puissance actuelle)",
  tariff_entity: "Période tarifaire en cours du ZLinky (LTARF ou PTEC en Zigbee2MQTT, active_register_tier_delivered en ZHA ; facultatif)",
  current_entity: "Courant du ZLinky (IRMS1, facultatif)",
  voltage_entity: "Tension du ZLinky (URMS1, facultatif)",
  max_power_entity: "Puissance maximale du jour (SMAXSN, facultatif)",
  lqi_entity: "Qualité du lien Zigbee (linkquality, facultatif)",
  ccasn_entity: "Puissance active moyenne sur 30 minutes (CCASN, facultatif)",
  show_ccasn: "Afficher la puissance des 30 dernières minutes",
  ccasn_prev_entity: "Puissance active des 30 minutes précédentes (CCASN-1, facultatif)",
  show_ccasn_prev: "Afficher la puissance des 30 minutes précédentes",
  message_entity: "Message 1 du compteur (MSG1, facultatif)",
  message2_entity: "Message 2 du compteur (MSG2, facultatif)",
  show_messages: "Afficher les messages du compteur en fenêtre (fermeture par ×, retour si le message change)",
  message_test: "Tester la fenêtre de message (à couper après l'essai)",
  show_live: "Afficher la section « En direct » (puissance, courant, tension, tarif et prix)",
  show_index: "Afficher la section « Index du compteur »",
  show_totals: "Afficher la section « Semaine, mois et année »",
  show_chart: "Afficher la section « Historique » (graphique des derniers jours)",
  live_open: "Section « En direct » ouverte au départ (rabattable d'un clic sur la carte)",
  index_open: "Section « Index du compteur » ouverte au départ (rabattable d'un clic sur la carte)",
  totals_open: "Section « Semaine, mois et année » ouverte au départ (rabattable d'un clic sur la carte)",
  chart_open: "Section « Historique » (graphique des derniers jours) ouverte au départ (rabattable d'un clic sur la carte)",
  show_details: "Afficher le détail du jour (énergie et coût par index, abonnement, total)",
  show_meter: "Afficher le compteur en direct (puissance, courant, tarif et prix, index, part HC)",
  hc_blue_entity: "Tempo : index HC jour bleu",
  hp_blue_entity: "Tempo : index HP jour bleu",
  hc_white_entity: "Tempo : index HC jour blanc",
  hp_white_entity: "Tempo : index HP jour blanc",
  hc_red_entity: "Tempo : index HC jour rouge",
  hp_red_entity: "Tempo : index HP jour rouge",
  energy_prices: "Prendre les prix du tableau Énergie (les prix saisis ci-dessous restent prioritaires)",
  subscription_price: "Abonnement mensuel TTC (facultatif : ajouté au coût, au prorata)",
  hc_price: "Prix du kWh en heures creuses, TTC (facultatif : remplace celui du tableau Énergie)",
  hp_price: "Prix du kWh en heures pleines, TTC (facultatif : remplace celui du tableau Énergie)",
  base_price: "Prix du kWh, option Base, TTC (facultatif)",
  show_tempo: "Afficher Tempo (couleurs d'aujourd'hui et de demain, capteurs RTE)",
};

const ZlinkyCardEditor = makeEditor(ZL_SCHEMA, ZL_LABELS, ZL_DEFAULTS, HC_HP_COLORS);

/* ---------------------------------------------------------- enregistrement */

if (typeof customElements !== "undefined") {
  const define = (name, cls) => { if (!customElements.get(name)) customElements.define(name, cls); };
  define("zlinky-card", ZlinkyCard);
  define("zlinky-card-editor", ZlinkyCardEditor);
  window.customCards = window.customCards || [];
  if (!window.customCards.some((c) => c.type === "zlinky-card")) {
    window.customCards.push({
      type: "zlinky-card",
      name: "Carte ZLinky",
      description: "Consommation du LiXee ZLinky en direct (statistiques Home Assistant), présentée comme la carte Enedis Linky New.",
      preview: false,
    });
  }
  console.info(`%c ZLINKY-CARD %c ${CARD_VERSION} © Marlboro62 `, "background:#96d21f;color:#1a2434;font-weight:700", "background:#1d93e3;color:#fff");
}

})();
