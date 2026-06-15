import { redirect } from "next/navigation";

// Verejná registrácia je vypnutá – účty spravuje admin v /dashboard/admin/users.
export default function SignupPage() {
    redirect("/login");
}
