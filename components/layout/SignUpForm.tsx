'use client';

import { signup } from '@/lib/actions';
import { usernameSchema, emailSchema } from '@/lib/validation';
import { useActionState, useState } from 'react';

// požiadavky na heslo ako dáta — checklist sa z nich vygeneruje
const passwordChecks = [
  { label: 'Aspoň 8 znakov', test: (p: string) => p.length >= 8 },
  { label: 'Veľké písmeno', test: (p: string) => /[A-Z]/.test(p) },
  { label: 'Číslo', test: (p: string) => /[0-9]/.test(p) },
];

export default function SignupForm() {
  const [errorMessage, formAction, isPending] = useActionState(signup, undefined);

  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // "touched" = užívateľ už pole opustil → až vtedy ukazuj chyby
  const [touched, setTouched] = useState({ username: false, email: false });

  const usernameError = usernameSchema.safeParse(username).error?.issues[0]?.message;
  const emailError = emailSchema.safeParse(email).error?.issues[0]?.message;
  const passwordOk = passwordChecks.every((c) => c.test(password));
  const formOk = !usernameError && !emailError && passwordOk;

  return (
    <form action={formAction} className="space-y-3">
      <div className="flex-1 rounded-lg bg-gray-50 px-6 pb-4 pt-8">
        <h1 className="mb-3 text-2xl">Vytvor si účet</h1>

        {/* USERNAME */}
        <label className="mb-1 mt-5 block text-xs font-medium" htmlFor="username">
          Používateľské meno
        </label>
        <input
          className={`block w-full rounded-md border py-[9px] px-3 text-sm ${
            touched.username && usernameError ? 'border-red-400' : 'border-gray-200'
          }`}
          id="username" name="username" type="text" required
          value={username}
          onChange={(e) => setUsername(e.target.value.toLowerCase())}
          onBlur={() => setTouched((t) => ({ ...t, username: true }))}
        />
        {touched.username && usernameError && (
          <p className="mt-1 text-xs text-red-500">{usernameError}</p>
        )}

        {/* EMAIL */}
        <label className="mb-1 mt-5 block text-xs font-medium" htmlFor="email">Email</label>
        <input
          className={`block w-full rounded-md border py-[9px] px-3 text-sm ${
            touched.email && emailError ? 'border-red-400' : 'border-gray-200'
          }`}
          id="email" name="email" type="email" required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onBlur={() => setTouched((t) => ({ ...t, email: true }))}
        />
        {touched.email && emailError && (
          <p className="mt-1 text-xs text-red-500">{emailError}</p>
        )}

        {/* HESLO + live checklist */}
        <label className="mb-1 mt-5 block text-xs font-medium" htmlFor="password">Heslo</label>
        <input
          className="block w-full rounded-md border border-gray-200 py-[9px] px-3 text-sm"
          id="password" name="password" type="password" required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <ul className="mt-2 space-y-1">
          {passwordChecks.map((check) => {
            const ok = check.test(password);
            return (
              <li key={check.label}
                  className={`text-xs ${ok ? 'text-green-600' : 'text-gray-400'}`}>
                {ok ? '✓' : '○'} {check.label}
              </li>
            );
          })}
        </ul>

        <button className="mt-4 w-full disabled:opacity-50"
                disabled={!formOk || isPending}>
          {isPending ? 'Vytváram...' : 'Zaregistrovať sa'}
        </button>

        <div className="flex h-8 items-end" aria-live="polite">
          {errorMessage && <p className="text-sm text-red-500">{errorMessage}</p>}
        </div>
      </div>
    </form>
  );
}