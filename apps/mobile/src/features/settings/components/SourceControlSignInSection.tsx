import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { useGT } from "gt-react-native";
import type { SourceControlProviderAuth, SourceControlSignInPrompt } from "@t3tools/contracts";
import {
  appSignOutRequest,
  namedServerSignInStatus,
  normalizeServerAddressHost,
  readHostCredentialSettings,
  signedInServers,
  tokenOverridesSignIn,
  type SourceControlAppSignIn,
  type SourceControlDefinition,
} from "@t3tools/client-runtime/source-control-clients";
import * as Cause from "effect/Cause";
import * as Clipboard from "expo-clipboard";
import { useRef, useState } from "react";
import { tryOpenExternalUrl } from "../../../lib/openExternalUrl";
import { m } from "../../../i18n/messages";

import * as Dialog from "../../../components/ui/Dialog";
import { serverEnvironment } from "../../../state/server";
import { sourceControlEnvironment } from "../../../state/sourceControl";
import { useAtomCommand } from "../../../state/use-atom-command";
import type { SettingsTarget } from "../settings-environment-filter";
import { SettingsRow } from "./SettingsRow";

const failureMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? (errorDisplayMessage(error, m) ?? error.message) : String(error);
};

const openUrl = (url: string) => void tryOpenExternalUrl(url, "provider-auth");

interface AppSignInProps {
  readonly environment: SettingsTarget;
  readonly label: string;
  readonly definition: SourceControlDefinition;
  readonly appSignIn: SourceControlAppSignIn;
  /** What discovery reports; its accounts are the signed-in ones where no token overrides them. */
  readonly auth: SourceControlProviderAuth | undefined;
  readonly disabled: boolean;
}

/** Starts, shows, cancels and ends device-flow sign-ins of one host kind. */
function useAppSignIn(props: AppSignInProps) {
  const gt = useGT();
  const { environment, definition, appSignIn } = props;
  const environmentId = environment.environmentId;
  const start = useAtomCommand(sourceControlEnvironment.startSignIn, { reportFailure: false });
  const wait = useAtomCommand(sourceControlEnvironment.waitForSignIn, { reportFailure: false });
  const cancel = useAtomCommand(sourceControlEnvironment.cancelSignIn, { reportFailure: false });
  const signOutOf = useAtomCommand(sourceControlEnvironment.signOut, {
    label: `sign out of ${appSignIn.appName}`,
  });
  const clearSignIn = useAtomCommand(serverEnvironment.updateSettings, {
    label: `sign out of ${appSignIn.appName}`,
  });
  // The attempt a pending `wait` belongs to; a cancel or a newer attempt makes its outcome stale.
  const attempt = useRef<SourceControlSignInPrompt | null>(null);
  const [pending, setPending] = useState<{
    readonly host: string;
    readonly prompt: SourceControlSignInPrompt | "starting";
  } | null>(null);
  const inputFor = (host: string) => ({ provider: definition.kind, host });

  const showCode = (host: string, prompt: SourceControlSignInPrompt) => {
    void Clipboard.setStringAsync(prompt.userCode).catch(() => undefined);
    const complete = prompt.verificationUriComplete;
    const instructions =
      complete === undefined
        ? gt(
            "Enter this code on {host}, then approve {app}. It is copied. The server finishes signing in even if you leave the app.",
            { host: definition.label, app: appSignIn.appName },
          )
        : gt(
            "Approve {app} on {host} only if it shows this code, and type the part of it the page asks for. The server finishes signing in even if you leave the app.",
            { host: definition.label, app: appSignIn.appName },
          );
    Dialog.alert(
      prompt.userCode,
      prompt.scopes === undefined
        ? instructions
        : `${instructions}\n\n${gt("Asks for {scopes}. {host} explains each before you approve.", {
            scopes: prompt.scopes.join(" "),
            host: definition.label,
          })}`,
      [
        {
          text: gt("Cancel"),
          style: "cancel",
          onPress: () => {
            attempt.current = null;
            setPending(null);
            void cancel({ environmentId, input: inputFor(host) });
          },
        },
        {
          text: gt("Open {host}", { host: definition.label }),
          onPress: () => openUrl(complete ?? prompt.verificationUri),
        },
      ],
    );
  };

  const signIn = async (host: string) => {
    setPending({ host, prompt: "starting" });
    const started = await start({ environmentId, input: inputFor(host) });
    if (started._tag !== "Success") {
      setPending(null);
      Dialog.alert(gt("Could not start the sign-in"), failureMessage(started.cause));
      return;
    }
    const prompt = started.value;
    attempt.current = prompt;
    setPending({ host, prompt });
    showCode(host, prompt);
    const finished = await wait({ environmentId, input: inputFor(host) });
    if (attempt.current !== prompt) return;
    attempt.current = null;
    setPending(null);
    if (finished._tag !== "Success") {
      Dialog.alert(gt("Sign-in did not finish"), failureMessage(finished.cause));
    }
  };

  const signOut = (host: string) => {
    const { signIns } = readHostCredentialSettings(
      environment.serverConfig.settings,
      definition.kind,
    );
    const request = appSignOutRequest(
      environment.serverConfig.environment.capabilities,
      inputFor(host),
      signIns,
    );
    void (request.via === "sign-out"
      ? signOutOf({ environmentId, input: request.input })
      : clearSignIn({ environmentId, input: { patch: request.patch } }));
  };

  /** The row's value while a sign-in is underway, else null. */
  const pendingValue = () =>
    pending === null
      ? null
      : pending.prompt === "starting"
        ? gt("Starting…")
        : gt("Enter {code}", { code: pending.prompt.userCode });

  /** Shows the code again, or starts a sign-in to `host` when none is underway. */
  const resume = (host: () => string | null) => {
    if (pending !== null && pending.prompt !== "starting") showCode(pending.host, pending.prompt);
    else if (pending === null) {
      const target = host();
      if (target !== null) void signIn(target);
    }
  };

  return { signIn, signOut, pending, pendingValue, resume };
}

/** Signs an environment in through a forge's own app, such as T3 Code for GitHub. */
export function AppSignInRow(props: AppSignInProps) {
  return props.appSignIn.hosts === undefined ? (
    <NamedServerSignInRows {...props} />
  ) : (
    <FixedHostSignInRow {...props} host={props.appSignIn.hosts[0] ?? ""} />
  );
}

function FixedHostSignInRow(props: AppSignInProps & { readonly host: string }) {
  const gt = useGT();
  const { environment, definition, appSignIn, host } = props;
  const { signIns } = readHostCredentialSettings(
    environment.serverConfig.settings,
    definition.kind,
  );
  const signedIn = (signIns[host] ?? "").length > 0;
  const flow = useAppSignIn(props);
  const installUrl = appSignIn.installUrl;

  const onPress = () => {
    if (!signedIn) return flow.resume(() => host);
    Dialog.alert(
      appSignIn.appName,
      gt(
        "Signed in. {host} requests use the app's higher rate limit, in repositories where the app is installed.",
        { host: definition.label },
      ),
      [
        ...(installUrl === undefined
          ? []
          : [{ text: gt("Install on an organization"), onPress: () => openUrl(installUrl) }]),
        { text: gt("Sign out"), style: "destructive" as const, onPress: () => flow.signOut(host) },
        { text: gt("Cancel"), style: "cancel" as const },
      ],
    );
  };

  return (
    <SettingsRow
      icon="person.crop.circle"
      label={props.label}
      value={signedIn ? gt("Signed in") : (flow.pendingValue() ?? gt("Sign in"))}
      disabled={props.disabled}
      onPress={onPress}
    />
  );
}

/** A host with no fixed address: a row per server signed in to, and one to sign in to another. */
function NamedServerSignInRows(props: AppSignInProps) {
  const gt = useGT();
  const { environment, definition, appSignIn } = props;
  const { signIns, tokens } = readHostCredentialSettings(
    environment.serverConfig.settings,
    definition.kind,
  );
  const servers = signedInServers(signIns);
  const flow = useAppSignIn(props);
  const pendingLabel = flow.pendingValue();
  const pendingHost = flow.pending === null ? null : normalizeServerAddressHost(flow.pending.host);
  const statusOf = (host: string) =>
    namedServerSignInStatus(props.auth?.accounts, host, tokenOverridesSignIn(tokens[host]));
  /** A row's value: a server turned off or refused says so, and a token that overrides it too. */
  const statusValue = (host: string) => {
    const status = statusOf(host);
    return status.kind === "overridden"
      ? gt("Signed in · saved token used")
      : status.kind === "error"
        ? `${gt("Signed in")} · ${status.error}`
        : gt("Signed in");
  };
  const statusMessage = (host: string) => {
    const status = statusOf(host);
    return status.kind === "authenticated"
      ? gt("Signed in as {account} with {app}.", {
          account: status.account,
          app: appSignIn.appName,
        })
      : gt("Signed in with {app}.", { app: appSignIn.appName });
  };

  const askForServer = () =>
    Dialog.prompt({
      title: gt("Sign in to {host}", { host: definition.label }),
      message: gt("Your {host} server's address, such as https://git.example.com.", {
        host: definition.label,
      }),
      initialValue: "",
      confirmText: gt("Sign in"),
      onConfirm: (value) => {
        if (value.trim() !== "") void flow.signIn(value.trim());
      },
    });

  return (
    <>
      {servers.map((host) => (
        <SettingsRow
          key={host}
          icon="person.crop.circle"
          label={host}
          value={(pendingHost === host ? pendingLabel : null) ?? statusValue(host)}
          disabled={props.disabled}
          onPress={() =>
            flow.pending !== null
              ? flow.resume(() => null)
              : Dialog.alert(host, statusMessage(host), [
                  {
                    text: gt("Manage on {host}", { host: definition.label }),
                    onPress: () => openUrl(appSignIn.revokeUrl(host)),
                  },
                  { text: gt("Sign in again"), onPress: () => void flow.signIn(host) },
                  {
                    text: gt("Sign out"),
                    style: "destructive" as const,
                    onPress: () => flow.signOut(host),
                  },
                  { text: gt("Cancel"), style: "cancel" as const },
                ])
          }
        />
      ))}
      <SettingsRow
        icon="plus"
        label={gt("Sign in to a server")}
        {...(pendingLabel !== null && (pendingHost === null || !servers.includes(pendingHost))
          ? { value: pendingLabel }
          : {})}
        disabled={props.disabled}
        onPress={() => (flow.pending === null ? askForServer() : flow.resume(() => null))}
      />
    </>
  );
}
