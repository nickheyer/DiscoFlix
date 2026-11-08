import { bytesJson, jsonBytes } from '#lib/api/bytes';

type Json = Record<string, unknown>;

function b64uDecode(text: string): ArrayBuffer {
	const base64 = text.replaceAll('-', '+').replaceAll('_', '/');
	const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
	const binary = atob(padded);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out.buffer;
}

function b64uEncode(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

// Accepts either bare options or the go-webauthn envelope that nests them under publicKey
function unwrap<T>(bytes: Uint8Array): T {
	const parsed = bytesJson<Json>(bytes);
	return (parsed.publicKey && typeof parsed.publicKey === 'object' ? parsed.publicKey : parsed) as T;
}

function descriptors(
	list: PublicKeyCredentialDescriptorJSON[] | undefined
): PublicKeyCredentialDescriptor[] | undefined {
	return list?.map((d) => ({
		id: b64uDecode(d.id),
		type: d.type as PublicKeyCredentialType,
		transports: d.transports as AuthenticatorTransport[] | undefined
	}));
}

function creationOptions(json: PublicKeyCredentialCreationOptionsJSON): PublicKeyCredentialCreationOptions {
	if ('parseCreationOptionsFromJSON' in PublicKeyCredential)
		return PublicKeyCredential.parseCreationOptionsFromJSON(json);
	return {
		...json,
		attestation: json.attestation as AttestationConveyancePreference | undefined,
		challenge: b64uDecode(json.challenge),
		user: { ...json.user, id: b64uDecode(json.user.id) },
		excludeCredentials: descriptors(json.excludeCredentials),
		extensions: json.extensions as AuthenticationExtensionsClientInputs | undefined
	};
}

function requestOptions(json: PublicKeyCredentialRequestOptionsJSON): PublicKeyCredentialRequestOptions {
	if ('parseRequestOptionsFromJSON' in PublicKeyCredential)
		return PublicKeyCredential.parseRequestOptionsFromJSON(json);
	return {
		...json,
		challenge: b64uDecode(json.challenge),
		allowCredentials: descriptors(json.allowCredentials),
		userVerification: json.userVerification as UserVerificationRequirement | undefined,
		extensions: json.extensions as AuthenticationExtensionsClientInputs | undefined
	};
}

// Serializes a credential in the WebAuthn JSON format, natively when the browser can
function credentialJson(credential: PublicKeyCredential): unknown {
	if (typeof credential.toJSON === 'function') return credential.toJSON();
	const base = {
		id: credential.id,
		rawId: b64uEncode(credential.rawId),
		type: credential.type,
		authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
		clientExtensionResults: credential.getClientExtensionResults()
	};
	const r = credential.response;
	if (r instanceof AuthenticatorAttestationResponse) {
		const publicKey = r.getPublicKey();
		return {
			...base,
			response: {
				clientDataJSON: b64uEncode(r.clientDataJSON),
				attestationObject: b64uEncode(r.attestationObject),
				authenticatorData: b64uEncode(r.getAuthenticatorData()),
				transports: r.getTransports(),
				publicKeyAlgorithm: r.getPublicKeyAlgorithm(),
				publicKey: publicKey ? b64uEncode(publicKey) : undefined
			}
		};
	}
	const assertion = r as AuthenticatorAssertionResponse;
	return {
		...base,
		response: {
			clientDataJSON: b64uEncode(assertion.clientDataJSON),
			authenticatorData: b64uEncode(assertion.authenticatorData),
			signature: b64uEncode(assertion.signature),
			userHandle: assertion.userHandle ? b64uEncode(assertion.userHandle) : undefined
		}
	};
}

export function passkeysSupported(): boolean {
	return typeof window.PublicKeyCredential === 'function' && typeof navigator.credentials?.get === 'function';
}

export async function conditionalAvailable(): Promise<boolean> {
	if (!passkeysSupported() || typeof PublicKeyCredential.isConditionalMediationAvailable !== 'function') return false;
	return PublicKeyCredential.isConditionalMediationAvailable();
}

// Runs the registration ceremony and returns the credential JSON bytes for the server
export async function createPasskey(optionsJson: Uint8Array): Promise<Uint8Array> {
	const publicKey = creationOptions(unwrap<PublicKeyCredentialCreationOptionsJSON>(optionsJson));
	const credential = await navigator.credentials.create({ publicKey });
	if (!(credential instanceof PublicKeyCredential)) throw new Error('The browser did not return a passkey');
	return jsonBytes(credentialJson(credential));
}

// Runs the sign-in ceremony and returns the assertion JSON bytes, or null when the user dismissed it
export async function getPasskey(
	optionsJson: Uint8Array,
	mediation: CredentialMediationRequirement,
	signal: AbortSignal
): Promise<Uint8Array | null> {
	const publicKey = requestOptions(unwrap<PublicKeyCredentialRequestOptionsJSON>(optionsJson));
	const credential = await navigator.credentials.get({ publicKey, mediation, signal });
	if (!credential) return null;
	if (!(credential instanceof PublicKeyCredential)) throw new Error('The browser did not return a passkey');
	return jsonBytes(credentialJson(credential));
}
