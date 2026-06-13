"use client";

import { authenticate } from "@/lib/actions";
import { useSearchParams } from "next/navigation";
import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardFooter,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";

export default function LoginForm() {
    const searchParams = useSearchParams();
    const callbackUrl = searchParams.get("callbackUrl") || "/dashboard";
    const [errorMessage, formAction, isPending] = useActionState(
        authenticate,
        undefined,
    );

    return (
        <Card className="w-full max-w-sm">
            <CardHeader>
                <CardTitle className="text-2xl">Prihlásenie</CardTitle>
                <CardDescription>Zadaj svoje uživateľské meno a heslo</CardDescription>
            </CardHeader>
            <form action={formAction}>
                <CardContent className="grid gap-4">
                    <div className="grid gap-2">
                        <Label htmlFor="username">Používateľské meno</Label>
                        <Input
                            id="username"
                            type="text"
                            name="username"
                            placeholder="jmrkvicka"
                            autoComplete="username"
                            autoCapitalize="none"
                            required
                        />
                    </div>
                    <div className="grid gap-2">
                        <Label htmlFor="password">Heslo</Label>
                        <Input
                            id="password"
                            type="password"
                            name="password"
                            required
                            minLength={6}
                        />
                    </div>
                    <div className="flex items-center gap-2 pb-4">
                        <Checkbox id="remember" name="remember" />
                        <Label
                            htmlFor="remember"
                            className="font-normal text-muted-foreground"
                        >
                            Zapamätať si ma
                        </Label>
                    </div>
                    <input
                        type="hidden"
                        name="redirectTo"
                        value={callbackUrl}
                    />
                    {errorMessage && (
                        <p
                            className="text-sm text-destructive"
                            aria-live="polite"
                        >
                            {errorMessage}
                        </p>
                    )}
                </CardContent>
                <CardFooter className="pt-4">
                    <Button
                        type="submit"
                        className="w-full"
                        disabled={isPending}
                    >
                        {isPending ? "Prihlasujem…" : "Prihlásiť sa"}
                    </Button>
                </CardFooter>
            </form>
        </Card>
    );
}
