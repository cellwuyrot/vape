import GauzeBlaze, { type GauzeBlazeProps } from "@/components/originkit/ui/hero-58/gauze-blaze";

export type Theme = "dark";

const FIT = { scale: 150, amplitude: 52 };

const BLAZE: GauzeBlazeProps = {
  ground: "dark",
  background: "#030712",
  baseColor: "#17D5C9",
  midColor: "#00B7D8",
  accentColor: "#B8F7FF",
  particles: 260,
  speed: 42,
  advanced: {
    coreColor: "#17D5C9",
    coreGain: 145,
    edgeGlow: 190,
    glowSize: 28,
    exposure: 350,
    lineOpacity: 58,
    emberSize: 90,
    hazeColor: "#06313A",
    haze: 42,
    vignette: 18,
  },
};

function ArrowIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12h15M13 6l6 6-6 6" />
    </svg>
  );
}

export default function Hero({ theme = "dark", settings = {} }: { theme?: Theme; settings?: Record<string, string> }) {
  return (
    <div className="page" data-theme={theme}>
      <section className="hero">
        <div className="visual" aria-hidden="true">
          <GauzeBlaze key={theme} {...FIT} {...BLAZE} />
        </div>

        <div className="hero-body">
          <div className="hero-copy">
            <p className="eyebrow">{settings.hero_eyebrow || "VAPELAB · ИНФОРМАЦИОННЫЙ КАТАЛОГ"}</p>

            <h1 className="hero-title">{settings.hero_title || "VAPELAB.\nКаталог и информация."}</h1>

            <p>{settings.hero_description || "Информационная площадка компании: розничное и оптовое направления, категории продукции и материалы о VAPELAB."}</p>
          </div>

          <a className="cta" href="#categories">
            {settings.hero_cta_label || "Открыть каталог"}
            <ArrowIcon />
          </a>
        </div>
      </section>
    </div>
  );
}