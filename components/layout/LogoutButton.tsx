import { logout } from "@/lib/actions";
import { Button } from "@/components/ui/button";

export default function LogoutButton() {
  return (
    <form action={logout}>
      <Button type="submit" variant="outline" size="sm">
        Odhlásiť sa
      </Button>
    </form>
  );
}