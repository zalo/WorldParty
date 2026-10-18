/** Discord Activity glue. Inside Discord the page is served through the app's proxy at
 *  https://<client id>.discordsays.com/ with a root URL mapping to the Worker, so every relative request
 *  (bundle, assets, the room WebSocket, chunk fetches) reaches the site unchanged; the proxy's CSP allows the
 *  whole app origin and nothing external, which this client never needs. The Embedded App SDK gives the
 *  activity instance (everyone who launched the activity from the same voice channel shares it, so it names
 *  the room) and, after an OAuth2 code exchange on the Worker (`/api/discord/token`, needs the
 *  DISCORD_CLIENT_SECRET secret), the player's Discord name. `?discord=mock` runs the same path in a
 *  normal browser against the SDK's mock. */
import { DiscordSDK, DiscordSDKMock } from '@discord/embedded-app-sdk';

/** 'live' inside Discord's iframe, 'mock' with ?discord=mock, else null. */
export function discordMode() {
    if(/\.discordsays\.com$/i.test(location.hostname)) return 'live';
    if(new URLSearchParams(location.search).get('discord') === 'mock') return 'mock';
    return null;
}

/** Handshake with the Discord client and sign the player in. Resolves to { sdk, mode, instanceId, name }
 *  where `name` is null when the sign-in is unavailable (no secret on the Worker, consent declined). */
export async function connectDiscord(mode, basePath = '') {
    let clientId = mode === 'live' ? location.hostname.split('.')[0] : 'mock';
    let sdk = mode === 'live' ? new DiscordSDK(clientId) : new DiscordSDKMock(clientId, null, null, null);
    await sdk.ready();
    let user = null;
    try {
        if(mode === 'mock') user = (await sdk.commands.authenticate({ access_token: 'mock' })).user;
        else {
            let { code } = await sdk.commands.authorize({ client_id: clientId, response_type: 'code', state: '', prompt: 'none', scope: ['identify'] });
            let res = await fetch(`${basePath}/api/discord/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, client_id: clientId }) });
            if(!res.ok) throw new Error(`token exchange ${res.status}: ${(await res.json().catch(() => ({}))).error || ''}`);
            let { access_token } = await res.json();
            user = (await sdk.commands.authenticate({ access_token })).user;
        }
    } catch(e) {
        console.warn('Discord sign-in skipped, playing anonymously: ' + e.message);
    }
    return { sdk, mode, instanceId: sdk.instanceId, user, name: user ? (user.global_name || user.username) : null };
}
