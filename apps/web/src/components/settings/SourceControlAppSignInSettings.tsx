import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m } from "~/i18n/messages";
import type {
  EnvironmentId,
  SourceControlProviderAuth,
  SourceControlSignInPrompt,
} from "@t3tools/contracts";
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
import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { msg, T, useGT, Var } from "gt-react";
import { CheckIcon, ExternalLinkIcon, CopyIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { T3AppIcon } from "~/components/T3AppIcon";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useServerConfigs } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button, InlineButton } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { RedactedSensitiveText } from "./RedactedSensitiveText";

type SignInState =
  | { readonly status: "idle" }
  | { readonly status: "starting"; readonly host: string }
  | {
      readonly status: "waiting";
      readonly host: string;
      readonly prompt: SourceControlSignInPrompt;
    }
  | { readonly status: "failed"; readonly message: string };

const failureMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? (thrownErrorMessage(error, m) ?? error.message) : String(error);
};

const expiryTime = (expiresAt: number) =>
  new Date(expiresAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

function ExternalLink(props: { readonly href: string; readonly children: ReactNode }) {
  return (
    <InlineButton render={<a href={props.href} target="_blank" rel="noreferrer noopener" />}>
      {props.children}
      <ExternalLinkIcon aria-hidden className="size-3" />
    </InlineButton>
  );
}

function AppMark(props: { readonly signedIn: boolean }) {
  return (
    <div className="relative size-10 shrink-0">
      <T3AppIcon className="size-full" />
      {props.signedIn ? (
        <span className="absolute -right-1 -bottom-1 grid size-4 place-items-center rounded-full bg-success text-white ring-2 ring-card">
          <CheckIcon aria-hidden className="size-2.5" strokeWidth={3} />
        </span>
      ) : null}
    </div>
  );
}

/** The device code, one cell per character, as GitHub prints it. */
function DeviceCode(props: { readonly code: string }) {
  return (
    <div className="flex items-center gap-1 font-mono text-lg font-medium">
      <span className="sr-only">{props.code}</span>
      {Array.from(props.code, (char, index) =>
        char === "-" ? (
          <span key={index} aria-hidden className="px-0.5 text-muted-foreground">
            –
          </span>
        ) : (
          <span
            key={index}
            aria-hidden
            className="grid h-10 w-8 place-items-center rounded-md border border-border bg-background shadow-xs"
          >
            {char}
          </span>
        ),
      )}
    </div>
  );
}

/** The code to approve and where, kept on screen while the browser asks about it. */
function DeviceCodePanel(props: {
  readonly definition: SourceControlDefinition;
  readonly prompt: SourceControlSignInPrompt;
}) {
  const gt = useGT();
  const { prompt } = props;
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    timeout: 1500,
    target: {
      target: "sign-in code",
      unavailableMessage: msg("Clipboard API is unavailable while copying sign-in code."),
      failureMessage: msg("Failed to copy sign-in code to the clipboard."),
    },
  });
  const host = props.definition.label;
  const complete = prompt.verificationUriComplete;
  return (
    <div className="grid gap-3 border-t border-border bg-muted/40 px-3 py-4">
      <div className="grid gap-4 sm:grid-cols-[auto_1fr] sm:items-center sm:gap-6">
        <div className="flex items-center gap-2">
          <DeviceCode code={prompt.userCode} />
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={gt("Copy code")}
            onClick={() => copyToClipboard(prompt.userCode, undefined)}
          >
            {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
          </Button>
        </div>
        <div className="grid gap-2 sm:justify-items-end">
          <Button
            size="sm"
            render={
              <a
                href={complete ?? prompt.verificationUri}
                target="_blank"
                rel="noreferrer noopener"
              />
            }
            onClick={() => copyToClipboard(prompt.userCode, undefined)}
          >
            <T>
              Copy code & open <Var>{host}</Var>
            </T>
            <ExternalLinkIcon aria-hidden className="size-3.5" />
          </Button>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span aria-hidden className="size-1.5 rounded-full bg-warning" />
            <T>
              Waiting for approval · code expires at <Var>{expiryTime(prompt.expiresAt)}</Var>
            </T>
          </p>
        </div>
      </div>
      {complete !== undefined || prompt.scopes !== undefined ? (
        <div className="grid gap-1 text-xs text-muted-foreground">
          {complete !== undefined ? (
            <p>
              <T>
                Approve only if <Var>{host}</Var> shows this code, and type the part of it the page
                asks for. On another device, go to <Var>{prompt.verificationUri}</Var>.
              </T>
            </p>
          ) : null}
          {prompt.scopes !== undefined ? (
            <p>
              <T>
                Asks for <Var>{prompt.scopes.join(" ")}</Var>. <Var>{host}</Var> explains each
                before you approve.
              </T>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Starts, waits for, cancels and ends device-flow sign-ins of one host kind. */
function useAppSignIn(props: {
  readonly environmentId: EnvironmentId;
  readonly definition: SourceControlDefinition;
  readonly appSignIn: SourceControlAppSignIn;
  readonly onChanged: () => void;
}) {
  const { environmentId, definition, onChanged } = props;
  const start = useAtomCommand(sourceControlEnvironment.startSignIn, { reportFailure: false });
  const wait = useAtomCommand(sourceControlEnvironment.waitForSignIn, { reportFailure: false });
  const cancelCommand = useAtomCommand(sourceControlEnvironment.cancelSignIn, {
    reportFailure: false,
  });
  const signOutOf = useAtomCommand(sourceControlEnvironment.signOut, {
    label: `sign out of ${props.appSignIn.appName}`,
  });
  const clearSignIn = useAtomCommand(serverEnvironment.updateSettings, {
    label: `sign out of ${props.appSignIn.appName}`,
  });
  const capabilities = useServerConfigs().get(environmentId)?.environment.capabilities;
  const { signIns } = useEnvironmentSettings(environmentId, (settings) =>
    readHostCredentialSettings(settings, definition.kind),
  );
  const canSignIn = useAtomValue(
    sourceControlEnvironment.startSignIn.permissionAtom(environmentId),
  );
  const [state, setState] = useState<SignInState>({ status: "idle" });
  const inputFor = (host: string) => ({ provider: definition.kind, host });

  const signIn = async (host: string): Promise<boolean> => {
    setState({ status: "starting", host });
    const started = await start({ environmentId, input: inputFor(host) });
    if (started._tag !== "Success") {
      setState({ status: "failed", message: failureMessage(started.cause) });
      return false;
    }
    const prompt = started.value;
    setState({ status: "waiting", host, prompt });
    const finished = await wait({ environmentId, input: inputFor(host) });
    // A newer attempt, a cancel, or a sign-out owns the state by now.
    setState((current) => {
      if (current.status !== "waiting" || current.prompt !== prompt) return current;
      return finished._tag === "Success"
        ? { status: "idle" }
        : { status: "failed", message: failureMessage(finished.cause) };
    });
    if (finished._tag === "Success") {
      onChanged();
      return true;
    }
    return false;
  };

  const cancel = () => {
    if (state.status === "waiting")
      void cancelCommand({ environmentId, input: inputFor(state.host) });
    setState({ status: "idle" });
  };

  const signOut = async (host: string) => {
    setState({ status: "idle" });
    const request = appSignOutRequest(capabilities, inputFor(host), signIns);
    // The command reports a failure. A host may fail after forgetting the sign-in here (it
    // could not be told), so rescan on every outcome; rescanning an unchanged host is harmless.
    await (request.via === "sign-out"
      ? signOutOf({ environmentId, input: request.input })
      : clearSignIn({ environmentId, input: { patch: request.patch } }));
    onChanged();
  };

  return { state, canSignIn, signIn, cancel, signOut };
}

function FailureNote(props: { readonly message: string }) {
  return (
    <p
      role="alert"
      className="border-t border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive"
    >
      {props.message}
    </p>
  );
}

export function SourceControlAppSignInSettings(props: {
  readonly environmentId: EnvironmentId;
  readonly definition: SourceControlDefinition;
  readonly appSignIn: SourceControlAppSignIn;
  /** What discovery reports; its accounts are the signed-in ones where no token overrides them. */
  readonly auth: SourceControlProviderAuth;
  readonly onChanged: () => void;
}) {
  return props.appSignIn.hosts === undefined ? (
    <NamedServerSignIn {...props} />
  ) : (
    <FixedHostSignIn {...props} host={props.appSignIn.hosts[0] ?? ""} />
  );
}

function FixedHostSignIn({
  environmentId,
  definition,
  appSignIn,
  auth,
  host,
  onChanged,
}: Parameters<typeof SourceControlAppSignInSettings>[0] & { readonly host: string }) {
  const gt = useGT();
  const account = Option.getOrNull(auth.account);
  const { signIns, tokens } = useEnvironmentSettings(environmentId, (settings) =>
    readHostCredentialSettings(settings, definition.kind),
  );
  const signedIn = (signIns[host] ?? "").length > 0;
  // A token read from a secret provider overrides the sign-in like a saved one.
  const tokenOverrides = tokenOverridesSignIn(tokens[host]);
  const { state, canSignIn, signIn, cancel, signOut } = useAppSignIn({
    environmentId,
    definition,
    appSignIn,
    onChanged,
  });

  const waiting = !signedIn && state.status === "waiting" ? state.prompt : null;

  let subtitle: ReactNode;
  let action: ReactNode;
  if (signedIn) {
    subtitle =
      account !== null && !tokenOverrides ? (
        <span className="flex min-w-0 items-center gap-1">
          <T>
            Signed in as
            <RedactedSensitiveText
              value={account}
              ariaLabel={gt("Signed-in {host} account", { host: definition.label })}
              revealTooltip={gt("Show account")}
              hideTooltip={gt("Hide account")}
            />
          </T>
        </span>
      ) : tokenOverrides ? (
        gt("Signed in, but the token saved below is used while it can be read.")
      ) : (
        gt("Signed in")
      );
    action = (
      <Button size="xs" variant="outline" disabled={!canSignIn} onClick={() => void signOut(host)}>
        <T>Sign out</T>
      </Button>
    );
  } else if (waiting !== null) {
    subtitle = gt("Approve the app on {host} to finish signing in.", { host: definition.label });
    action = (
      <Button size="xs" variant="ghost" onClick={cancel}>
        <T>Cancel</T>
      </Button>
    );
  } else {
    subtitle = gt("A far higher {host} API rate limit than a personal token or CLI login.", {
      host: definition.label,
    });
    action = (
      <Button
        size="xs"
        disabled={!canSignIn || state.status === "starting"}
        onClick={() => void signIn(host)}
      >
        {state.status === "starting" ? <Spinner /> : null}
        {state.status === "failed"
          ? gt("Try again")
          : gt("Sign in with {host}", { host: definition.label })}
      </Button>
    );
  }

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border bg-card",
        state.status === "failed" && !signedIn ? "border-destructive/40" : "border-border",
      )}
    >
      <div className="flex items-center gap-3 p-3">
        <AppMark signedIn={signedIn} />
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-sm font-medium text-foreground">{appSignIn.appName}</p>
          <div className="text-xs text-muted-foreground">{subtitle}</div>
        </div>
        <div className="shrink-0">{action}</div>
      </div>

      {waiting !== null ? <DeviceCodePanel definition={definition} prompt={waiting} /> : null}

      {signedIn ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {appSignIn.installUrl === undefined ? null : (
            <>
              <span className="min-w-0 flex-1">
                <T>Reaches repositories in accounts and organizations that installed the app.</T>
              </span>
              <ExternalLink href={appSignIn.installUrl}>
                <T>Install on an organization</T>
              </ExternalLink>
            </>
          )}
          <ExternalLink href={appSignIn.revokeUrl(host)}>
            <T>
              Manage on <Var>{definition.label}</Var>
            </T>
          </ExternalLink>
        </div>
      ) : null}

      {state.status === "failed" && !signedIn ? <FailureNote message={state.message} /> : null}
    </div>
  );
}

/** A host with no fixed address: the user names each server, and may sign in to several. */
function NamedServerSignIn({
  environmentId,
  definition,
  appSignIn,
  auth,
  onChanged,
}: Parameters<typeof SourceControlAppSignInSettings>[0]) {
  const gt = useGT();
  const { signIns, tokens } = useEnvironmentSettings(environmentId, (settings) =>
    readHostCredentialSettings(settings, definition.kind),
  );
  const servers = signedInServers(signIns);
  const [address, setAddress] = useState("");
  const { state, canSignIn, signIn, cancel, signOut } = useAppSignIn({
    environmentId,
    definition,
    appSignIn,
    onChanged,
  });
  const busy = state.status === "starting" || state.status === "waiting";

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border bg-card",
        state.status === "failed" ? "border-destructive/40" : "border-border",
      )}
    >
      <div className="flex items-center gap-3 p-3">
        <AppMark signedIn={servers.length > 0} />
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-sm font-medium text-foreground">{appSignIn.appName}</p>
          <p className="text-xs text-muted-foreground">
            {state.status === "waiting"
              ? gt("Approve the app on {host} to finish signing in.", {
                  host: normalizeServerAddressHost(state.host),
                })
              : gt(
                  "Sign in to your {host} server in the browser, with no token to create or paste.",
                  {
                    host: definition.label,
                  },
                )}
          </p>
        </div>
        {state.status === "waiting" ? (
          <div className="shrink-0">
            <Button size="xs" variant="ghost" onClick={cancel}>
              <T>Cancel</T>
            </Button>
          </div>
        ) : null}
      </div>

      {servers.map((host) => {
        const status = namedServerSignInStatus(
          auth.accounts,
          host,
          tokenOverridesSignIn(tokens[host]),
        );
        return (
          <div
            key={host}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-3 py-2 text-xs"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-foreground">{host}</p>
              <div className="text-muted-foreground">
                {status.kind === "overridden" ? (
                  gt("Signed in, but the token saved below is used while it can be read.")
                ) : status.kind === "authenticated" ? (
                  <span className="flex min-w-0 items-center gap-1">
                    <T>
                      Signed in as
                      <RedactedSensitiveText
                        value={status.account}
                        ariaLabel={gt("Signed-in {host} account", { host })}
                        revealTooltip={gt("Show account")}
                        hideTooltip={gt("Hide account")}
                      />
                    </T>
                  </span>
                ) : status.kind === "error" ? (
                  <span>
                    {gt("Signed in")} · {status.error}
                  </span>
                ) : (
                  gt("Signed in")
                )}
              </div>
            </div>
            <ExternalLink href={appSignIn.revokeUrl(host)}>
              <T>
                Manage on <Var>{definition.label}</Var>
              </T>
            </ExternalLink>
            <Button
              size="xs"
              variant="ghost"
              disabled={!canSignIn || busy}
              onClick={() => void signIn(host)}
            >
              <T>Sign in again</T>
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={!canSignIn}
              onClick={() => void signOut(host)}
            >
              <T>Sign out</T>
            </Button>
          </div>
        );
      })}

      {state.status === "waiting" ? (
        <DeviceCodePanel definition={definition} prompt={state.prompt} />
      ) : (
        <form
          className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = address.trim();
            if (trimmed !== "") {
              void signIn(trimmed).then((signedIn) => {
                if (signedIn) setAddress("");
              });
            }
          }}
        >
          <div className="min-w-48 flex-1">
            <Input
              size="sm"
              inputMode="url"
              autoComplete="off"
              aria-label={gt("{host} server address", { host: definition.label })}
              placeholder="https://git.example.com"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
            />
          </div>
          <Button type="submit" size="xs" disabled={!canSignIn || busy || address.trim() === ""}>
            {state.status === "starting" ? <Spinner /> : null}
            {gt("Sign in with {host}", { host: definition.label })}
          </Button>
        </form>
      )}

      {state.status === "failed" ? <FailureNote message={state.message} /> : null}
    </div>
  );
}
