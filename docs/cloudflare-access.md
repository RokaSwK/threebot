# Sign in with Google through Cloudflare

The Cloudflare link in **Settings → Remote access** is a quick tunnel: public, with no account, behind a password. If you have a domain on Cloudflare, you can instead put Threebot on your own address, such as `bot.example.com`, and sign in with your Google account. Nobody reaches the app until Google has checked them, and there's no password to type on your phone.

Cloudflare handles the Google login (Cloudflare Access). Threebot then checks Cloudflare's signed token on every request: its signature, its audience tag, its expiry, and that the email is on your list. A request that gets past Cloudflare without a valid token still doesn't get in.

It's free: Cloudflare Zero Trust's free plan covers up to 50 people.

## What you need

- A domain on Cloudflare, on any plan.
- A Cloudflare Zero Trust organization. The first time you open **Zero Trust** in the dashboard, it asks you to pick a team name. Your team domain is `<team-name>.cloudflareaccess.com`. You can find it later under **Zero Trust → Settings → Team name and domain**.
- A Google account, and access to the [Google Cloud console](https://console.cloud.google.com/).

## 1. Let Cloudflare sign people in with Google

In the Google Cloud console:

1. Create a project, for example "Threebot sign-in".
2. Go to **APIs & Services → Credentials** and select **Configure Consent Screen**. Choose **External**, and fill in an app name and your email.
3. Select **Create OAuth client**, with type **Web application**:
   - **Authorized JavaScript origins:** `https://<team-name>.cloudflareaccess.com`
   - **Authorized redirect URIs:** `https://<team-name>.cloudflareaccess.com/cdn-cgi/access/callback`
4. Copy the **Client ID** and **Client secret**.

In the Cloudflare dashboard:

1. Go to **Zero Trust → Integrations → Identity providers**, select **Add new identity provider**, then **Google**.
2. Paste the Client ID into **App ID**, and paste the **Client Secret**. Save.
3. Select **Test** next to Google. It should show your Google account.

## 2. Put Threebot on your domain with a tunnel

1. Go to **Networking → Tunnels** and select **Create a tunnel**. Name it `threebot`.
2. Pick your operating system. Copy the install command the dashboard shows and run it on the machine where Threebot runs. It installs `cloudflared` as a service with this tunnel's token. Wait for the tunnel to show **Healthy**.
3. On the tunnel's **Routes** tab, select **Add route → Published application**:
   - **Subdomain** `bot`, **Domain** `example.com`
   - **Service URL** `http://127.0.0.1:3780`, or Threebot's `PORT`

This is a separate tunnel from the quick tunnel in Settings. It runs as its own service, keeps the same address across restarts, and doesn't need **Remote access → Cloudflare link** turned on.

## 3. Require Google for that address

1. Go to **Zero Trust → Access controls → Applications**, select **Create new application → Self-hosted and private**, then **Add public hostname**: `bot.example.com`.
2. Add an **Allow** policy that includes **Emails**: your Gmail address, plus anyone else you want to let in.
3. Under login methods, choose only **Google** and turn on **Apply instant authentication**. That way you go straight to Google without Cloudflare's chooser page.
4. Set **Session Duration** to something long, such as one month, so your phone doesn't ask you to sign in every day.
5. Create the application. Then select **Edit** on it and copy the **Application Audience (AUD) Tag** under **Additional settings**.

## 4. Tell Threebot

Add these to `~/.threebot/.env`, or to the repository's `.env` for a source checkout:

```sh
CF_ACCESS_TEAM_DOMAIN=<team-name>.cloudflareaccess.com
CF_ACCESS_AUD=<the AUD tag>
CF_ACCESS_EMAILS=you@gmail.com
# Makes the links Bots share point at your address
APP_URL=https://bot.example.com
```

`CF_ACCESS_EMAILS` is a comma-separated list. Keep it the same as the Access policy, because Threebot only lets in emails on both. Then restart Threebot with `threebot service restart`, or restart `npm start`.

**Settings → Remote access** then shows Google sign-in as on, with the allowed emails.

## Check it

- Open `https://bot.example.com` in a private window. You should land on Google, then in the app.
- `curl -I https://bot.example.com/api/bots` should be stopped by Cloudflare with a redirect to the login page, never a `200`.
- **Sign Out** in Settings ends both the app session and the Cloudflare one.

## Good to know

- **Opening it on this machine.** With Access on, a request without a Cloudflare token only gets in with the app password. So `http://127.0.0.1:3780` stops working unless you set a password in **Settings → Remote access**. With one, the sign-in screen there asks for the password, and your own domain still goes through Google. The Tailscale link keeps working either way, because it signs you in with your Tailscale identity.
- **On your phone,** add `https://bot.example.com` to the home screen. Notifications work because it's HTTPS. Google sign-in happens inside the app the first time, then again when the Access session runs out.
- **The quick-tunnel link** in Settings isn't behind Access, so it still uses the password. You don't need it once your own domain works.
- **Turning it off:** remove the three `CF_ACCESS_*` lines and restart Threebot, then delete the Access application and the tunnel route in Cloudflare.
