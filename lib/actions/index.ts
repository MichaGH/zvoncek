'use server';
import { signIn, signOut } from '@/auth';
import { AuthError } from 'next-auth';
import z from 'zod';
import prisma from '@/lib/db';
import bcrypt from 'bcrypt'

export async function authenticate(
  prevState: string | undefined,
  formData: FormData,
) {
  try {
    await signIn('credentials', formData);
  } catch (error) {
    if (error instanceof AuthError) {
      switch (error.type) {
        case 'CredentialsSignin':
          return 'Invalid credentials.';
        default:
          return 'Something went wrong.';
      }
    }
    throw error;
  }
}


const SignupSchema = z.object({
  username: z.string().min(2, 'Meno musí mať aspoň 2 znaky.'),
  email: z.string().email('Neplatný email.'),
  password: z.string().min(6, 'Heslo musí mať aspoň 6 znakov.'),
});


export async function signup(
    prevState: string | undefined,
    formData: FormData
){

    // Validation Input
    const parsed = SignupSchema.safeParse({
        username: formData.get('username'),
        email: formData.get('email'),
        password: formData.get('password')
    });

    if (!parsed.success) {
        return parsed.error.issues[0].message;
    }

    const { username, email, password } = parsed.data

    // Check if user already exists

    const existing = await prisma.user.findUnique({where : { email}});
    if(existing) {
        return 'Účet s týmto emailom už existuje'
    }

    // Hash password and save it
    const passwordHash = await bcrypt.hash(password, 10)
    await prisma.user.create({
        data: {
          username,
          email,
          firstName: username,
          lastName: '',
          password: passwordHash,
        },
    })

    // Automatically log in user

    try {
        await signIn('credentials', { email, password, redirectTo: '/dashboard'});
    } catch (error) {
        if (error instanceof AuthError) {
            return 'účet je vytvorený, ale prihlásenie zlyhalo. Skús sa znovu prihlásiť'
        }

        throw error
    }
}


// kdekoľvek do súboru
export async function logout() {
  await signOut({ redirectTo: '/' });
}
