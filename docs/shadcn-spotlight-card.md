# Spotlight Card / shadcn integration

В текущей версии Miracle Boost основной сайт сделан на vanilla HTML/CSS/JS + Node API. Это не React-проект, поэтому React-компонент не подключается в сборку сайта напрямую.

Я добавил готовый файл компонента сюда:

```txt
components/ui/spotlight-card.tsx
components/ui/spotlight-card.demo.tsx
```

Для настоящего shadcn/React-проекта структура должна поддерживать TypeScript, Tailwind CSS и alias `@/components/ui`. Стандартный путь `/components/ui` важен, потому что shadcn и импорты вида `@/components/ui/spotlight-card` ожидают именно эту директорию.

Быстрая установка для отдельного React/shadcn проекта:

```bash
npm create vite@latest miracle-boost-react -- --template react-ts
cd miracle-boost-react
npm install
npm install -D tailwindcss postcss autoprefixer
npx tailwindcss init -p
npx shadcn@latest init
mkdir -p components/ui
```

После этого скопируйте `components/ui/spotlight-card.tsx` в `/components/ui/spotlight-card.tsx` и используйте:

```tsx
import { GlowCard } from '@/components/ui/spotlight-card';
```

В текущем vanilla-сайте я реализовал такой же spotlight/glow-эффект через CSS и JavaScript для карточек калькулятора, этапов, преимуществ и FunPay-отзывов.
