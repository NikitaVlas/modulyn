export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col justify-center px-6 py-16 sm:px-12">
      <p className="mb-12 text-sm font-semibold tracking-[0.25em] text-teal-800">MODULYN</p>
      <h1 className="max-w-2xl text-4xl font-semibold tracking-tight sm:text-6xl">Основа для вашей CRM.</h1>
      <p className="mt-6 max-w-xl text-lg leading-8 text-slate-600">Одна платформа для независимых команд. Пользователи, данные и модули каждой компании — в своём пространстве.</p>
      <div className="mt-12 border-t border-slate-300 pt-6">
        <p className="text-sm font-medium text-slate-800">Проект в разработке</p>
        <p className="mt-2 max-w-xl leading-7 text-slate-600">Сейчас готовится техническая основа. Вход и рабочие разделы появятся на следующих этапах.</p>
      </div>
    </main>
  );
}
