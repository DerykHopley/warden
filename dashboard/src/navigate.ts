// Leaving Warden for another site (GitHub's sign-in), kept apart so a test can see where the page sends the person.
export function goTo(url: string) {
  location.assign(url);
}
