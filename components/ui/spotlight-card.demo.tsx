import { GlowCard } from '@/components/ui/spotlight-card';

export function Default() {
  return (
    <div className="flex min-h-screen w-screen flex-row items-center justify-center gap-10 bg-slate-950 p-10">
      <GlowCard glowColor="red">
        <div className="relative z-10 text-white">Безопасность</div>
      </GlowCard>
      <GlowCard glowColor="red">
        <div className="relative z-10 text-white">Коммуникация</div>
      </GlowCard>
      <GlowCard glowColor="red">
        <div className="relative z-10 text-white">Приватность</div>
      </GlowCard>
    </div>
  );
}
