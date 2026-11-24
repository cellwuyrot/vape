import Hero from "@/components/originkit/ui/hero-58/hero-58-hero";

export default function App({ settings }: { settings?: Record<string, string> }) {
  return <Hero theme="dark" settings={settings} />;
}
