import React, { useEffect, useRef, useState } from 'react';
import {
  addDoc,
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
} from 'firebase/firestore';
import {
  ArrowLeft,
  Flag,
  ImagePlus,
  Lock,
  MessageSquare,
  Mic,
  Send,
  ShieldAlert,
  Square,
} from 'lucide-react';
import { ChatMessageRecord, ConversationRecord, PublicProfile } from '../types';
import { db, validateAndProcessImageFile } from '../lib/firebase';
import {
  detectSensitiveOrOffPlatformContent,
  sanitizeSafeAudioSrc,
  sanitizeSafeImageSrc,
  validateAudioMagicBytes,
} from '../lib/marketplaceLogic';
import { PAUSED_CONVERSATION_NOTICE } from '../lib/moderationEngine';
import {
  inspectMediaClient,
  inspectTextClient,
  stripDataUrlPrefix,
  type ReportModalTarget,
} from '../lib/moderationClient';
import { emitUserNotification } from '../lib/notificationService';
import { UserPresenceBadge } from './UserPresenceBadge';
import { ActiveStatus } from './ActiveStatus';

interface ChatViewProps {
  userUid: string | null;
  profile: PublicProfile | null;
  conversations: ConversationRecord[];
  initialConvId: string | null;
  onRequireAuth: () => void;
  onReportConversation?: (target: ReportModalTarget) => void;
  onFlash: (msg: string) => void;
}

export const ChatView: React.FC<ChatViewProps> = ({
  userUid,
  profile,
  conversations,
  initialConvId,
  onRequireAuth,
  onReportConversation,
  onFlash,
}) => {
  const [selectedId, setSelectedId] = useState<string | null>(initialConvId);
  const [messages, setMessages] = useState<ChatMessageRecord[]>([]);
  const [text, setText] = useState('');
  const [warning, setWarning] = useState('');
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [locallyPausedConvIds, setLocallyPausedConvIds] = useState<Record<string, string>>({});

  const imgInputRef = useRef<HTMLInputElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    if (initialConvId) setSelectedId(initialConvId);
  }, [initialConvId]);

  const activeConv = conversations.find((c) => c.id === selectedId) || null;

  useEffect(() => {
    if (!selectedId || !userUid) {
      setMessages([]);
      return;
    }
    const q = query(
      collection(db, 'conversations', selectedId, 'messages'),
      orderBy('createdAt', 'asc'),
      limit(300)
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        setMessages(
          snap.docs.map((d) => {
            const data = d.data();
            return {
              id: d.id,
              senderId: data.senderId,
              senderName: data.senderName,
              kind: data.kind || 'text',
              text: data.text || '',
              mediaData: data.mediaData,
              createdAtMs: data.createdAt?.toMillis?.() || Date.now(),
            };
          })
        );
      },
      (err) => console.warn('Chat listener warning:', err.message)
    );
    return () => unsub();
  }, [selectedId, userUid]);

  if (!userUid || !profile) {
    return (
      <div className="bx-wrap py-12">
        <div className="bx-card p-8 text-center max-w-md mx-auto space-y-3">
          <MessageSquare className="w-10 h-10 mx-auto" style={{ color: 'var(--orange)' }} />
          <h2 className="text-xl font-extrabold">Pre-Deal Messenger</h2>
          <p className="bx-hint">
            Sign in to message sellers and buyers securely before opening an escrow deal.
          </p>
          <button type="button" onClick={onRequireAuth} className="bx-btn bx-btn-primary">
            Sign In to Open Chat
          </button>
        </div>
      </div>
    );
  }

  const isBuyerInConv = activeConv ? activeConv.buyerId === userUid : false;
  const hasAcceptedSafety = activeConv
    ? isBuyerInConv
      ? activeConv.safetyAcceptedByBuyer
      : activeConv.safetyAcceptedBySeller
    : false;

  const handleAcknowledgeSafety = async () => {
    if (!activeConv) return;
    try {
      await updateDoc(doc(db, 'conversations', activeConv.id), {
        ...(isBuyerInConv ? { safetyAcceptedByBuyer: true } : { safetyAcceptedBySeller: true }),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Failed to save acknowledgement.');
    }
  };

  const isPausedForModeration = Boolean(
    activeConv && (activeConv.moderationPaused || locallyPausedConvIds[activeConv.id])
  );
  const pauseNoticeText =
    (activeConv && (locallyPausedConvIds[activeConv.id] || activeConv.moderationPauseReason)) ||
    PAUSED_CONVERSATION_NOTICE;

  const sendPayload = async (kind: 'text' | 'image' | 'voice', bodyText: string, mediaData?: string) => {
    if (!activeConv) return;
    if (isPausedForModeration) {
      setWarning('Messaging is temporarily paused while BEXORA reviews this conversation.');
      return;
    }
    setWarning('');
    const check = detectSensitiveOrOffPlatformContent(bodyText);
    if (check.blocked) {
      setWarning(check.reason || 'Message blocked for safety.');
      return;
    }

    setSending(true);
    try {
      const counterpartyId = isBuyerInConv ? activeConv.sellerId : activeConv.buyerId;
      const counterpartyName = isBuyerInConv ? activeConv.sellerName : activeConv.buyerName;

      if (kind === 'text') {
        const modRes = await inspectTextClient({
          surface: 'pre_deal_chat',
          callerName: profile.displayName,
          text: bodyText,
          conversationId: activeConv.id,
          listingId: activeConv.listingId,
          counterpartyId,
          counterpartyName,
        });
        if (modRes.conversationPaused) {
          setLocallyPausedConvIds((prev) => ({
            ...prev,
            [activeConv.id]: modRes.pauseNotice || PAUSED_CONVERSATION_NOTICE,
          }));
          return;
        }
        if (!modRes.allowed) {
          setWarning(
            `${modRes.userNoticeTitle ? `${modRes.userNoticeTitle}: ` : ''}${
              modRes.userNoticeMessage || 'Message blocked by BEXORA Trust & Safety.'
            }`
          );
          return;
        }
      } else if ((kind === 'image' || kind === 'voice') && mediaData) {
        const parsedMedia = stripDataUrlPrefix(mediaData);
        if (parsedMedia) {
          const modMedia = await inspectMediaClient({
            surface: 'pre_deal_chat',
            callerName: profile.displayName,
            items: [
              {
                id: `chat_${kind}_${Date.now()}`,
                kind: kind === 'voice' ? 'audio' : 'image',
                mimeType: parsedMedia.mimeType,
                base64Data: parsedMedia.base64Data,
              },
            ],
            conversationId: activeConv.id,
            listingId: activeConv.listingId,
          });
          if (modMedia.conversationPaused) {
            setLocallyPausedConvIds((prev) => ({
              ...prev,
              [activeConv.id]: modMedia.pauseNotice || PAUSED_CONVERSATION_NOTICE,
            }));
            return;
          }
          if (
            !modMedia.allowed ||
            modMedia.mediaScanStatus === 'blocked' ||
            modMedia.mediaScanStatus === 'quarantined'
          ) {
            setWarning(
              `${modMedia.userNoticeTitle ? `${modMedia.userNoticeTitle}: ` : ''}${
                modMedia.userNoticeMessage || 'Attachment blocked by BEXORA Trust & Safety.'
              }`
            );
            return;
          }
        }
      }

      const msgPayload: Record<string, unknown> = {
        senderId: userUid,
        senderName: profile.displayName,
        kind,
        text: bodyText.slice(0, 1500),
        createdAt: serverTimestamp(),
      };
      if (mediaData) msgPayload.mediaData = mediaData;

      const msgRef = await addDoc(
        collection(db, 'conversations', activeConv.id, 'messages'),
        msgPayload
      );
      const summaryPreview =
        kind === 'image'
          ? 'Sent an image attachment in pre-deal chat.'
          : kind === 'voice'
          ? 'Sent a voice message in pre-deal chat.'
          : bodyText.trim().slice(0, 140);
      await updateDoc(doc(db, 'conversations', activeConv.id), {
        lastMessage:
          kind === 'image'
            ? '[Image attachment]'
            : kind === 'voice'
            ? '[Voice message]'
            : bodyText.slice(0, 200),
        updatedAt: serverTimestamp(),
      });
      if (counterpartyId && counterpartyId !== userUid) {
        void emitUserNotification({
          recipientId: counterpartyId,
          actorId: userUid,
          actorRole: 'user',
          eventKey: `chat_msg_${msgRef.id}`,
          category: 'deal',
          severity: 'info',
          title: `New Message from ${profile.displayName}`,
          preview: summaryPreview,
          body: `${profile.displayName} sent a message regarding "${activeConv.listingTitle || 'Marketplace Listing'}":\n\n${summaryPreview}`,
          refType: 'conversation',
          refId: activeConv.id,
          referenceLabel: (activeConv.listingTitle || 'Pre-Deal Messenger').slice(0, 80),
          destination: `chat:${activeConv.id}`,
        });
      }
      if (kind === 'text') setText('');
    } catch (err) {
      setWarning(err instanceof Error ? err.message : 'Could not send message.');
    } finally {
      setSending(false);
    }
  };

  const handleImageAttachment = async (files: FileList | null) => {
    if (!files || !files[0]) return;
    try {
      const dataUrl = await validateAndProcessImageFile(files[0], 800, 0.72);
      await sendPayload('image', 'Shared an image', dataUrl);
    } catch (err) {
      setWarning(err instanceof Error ? err.message : 'Image upload failed.');
    } finally {
      if (imgInputRef.current) imgInputRef.current.value = '';
    }
  };

  const toggleVoiceRecording = async () => {
    if (recording && mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      setRecording(false);
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setWarning('Microphone recording is not supported on this browser.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        if (blob.size > 240_000) {
          setWarning('Voice clip is too long. Keep voice messages under 15 seconds.');
          return;
        }
        const rawBuf = new Uint8Array(await blob.arrayBuffer());
        const magicCheck = validateAudioMagicBytes(rawBuf);
        if (!magicCheck.valid) {
          setWarning(magicCheck.error || 'Voice recording format could not be verified.');
          return;
        }
        const normalizedBlob = new Blob([rawBuf], {
          type: magicCheck.detectedMime || 'audio/webm',
        });
        const dataUrl = await new Promise<string>((resolve) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result || ''));
          r.readAsDataURL(normalizedBlob);
        });
        if (!sanitizeSafeAudioSrc(dataUrl)) {
          setWarning('Voice recording format is not permitted.');
          return;
        }
        await sendPayload('voice', 'Voice message', dataUrl);
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch {
      setWarning('Microphone permission was denied or unavailable.');
    }
  };

  return (
    <div className="bx-wrap py-6">
      <div className="mb-4">
        <p className="text-xs font-extrabold uppercase tracking-wider" style={{ color: 'var(--orange)' }}>
          Pre-Deal Messenger
        </p>
        <h1 className="text-2xl font-extrabold">Buyer & Seller Chat</h1>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4 min-h-[520px]">
        {/* Conversation List */}
        <aside
          className={`bx-card p-3 space-y-2 ${activeConv ? 'hidden lg:block' : 'block'}`}
        >
          <h2 className="text-xs font-extrabold uppercase px-2 py-1" style={{ color: 'var(--text-2)' }}>
            Conversations ({conversations.length})
          </h2>
          {conversations.length === 0 ? (
            <div className="p-6 text-center space-y-2">
              <p className="text-sm font-bold">No conversations yet</p>
              <p className="bx-hint">
                Open any marketplace listing and click “Message Seller” to start chatting.
              </p>
            </div>
          ) : (
            conversations.map((conv) => {
              const peerName = conv.buyerId === userUid ? conv.sellerName : conv.buyerName;
              const peerUid = conv.buyerId === userUid ? conv.sellerId : conv.buyerId;
              const isSelected = conv.id === selectedId;
              return (
                <button
                  key={conv.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(conv.id);
                    setWarning('');
                  }}
                  className="w-full p-3 rounded-xl text-left transition-colors flex items-start gap-3"
                  style={{
                    background: isSelected ? 'var(--surface-2)' : 'transparent',
                    border: isSelected ? '1.5px solid var(--border-strong)' : '1.5px solid transparent',
                  }}
                >
                  <div className="relative shrink-0">
                    <div
                      className="w-10 h-10 rounded-full grid place-items-center font-extrabold text-xs text-white shrink-0"
                      style={{ background: 'var(--purple)' }}
                    >
                      {peerName.slice(0, 2).toUpperCase()}
                    </div>
                    <ActiveStatus userId={peerUid} viewerUserId={userUid} mode="dot" className="absolute -bottom-0.5 -right-0.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-1">
                      <span className="font-extrabold text-sm truncate">{peerName}</span>
                      <UserPresenceBadge uid={peerUid} mode="compact" className="text-[10px]" />
                    </div>
                    <div className="text-xs truncate font-semibold" style={{ color: 'var(--orange)' }}>
                      {conv.listingTitle}
                    </div>
                    <div className="bx-hint truncate mt-0.5">{conv.lastMessage || 'No messages yet'}</div>
                  </div>
                </button>
              );
            })
          )}
        </aside>

        {/* Active Message Thread */}
        <section className={`bx-card flex flex-col min-h-[480px] ${!activeConv ? 'hidden lg:flex' : 'flex'}`}>
          {!activeConv ? (
            <div className="m-auto p-8 text-center space-y-2">
              <MessageSquare className="w-9 h-9 mx-auto" style={{ color: 'var(--text-3)' }} />
              <p className="font-bold text-sm">Select a conversation to view messages</p>
            </div>
          ) : (
            <>
              <div
                className="p-4 border-b flex items-center justify-between gap-3"
                style={{ borderColor: 'var(--border-soft)' }}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <button
                    type="button"
                    onClick={() => setSelectedId(null)}
                    className="bx-icon-btn !w-9 !h-9 lg:hidden"
                    aria-label="Back to conversations"
                  >
                    <ArrowLeft className="w-4 h-4" />
                  </button>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-extrabold text-sm truncate">
                        {activeConv.buyerId === userUid ? activeConv.sellerName : activeConv.buyerName}
                      </h3>
                      <ActiveStatus
                        userId={activeConv.buyerId === userUid ? activeConv.sellerId : activeConv.buyerId}
                        viewerUserId={userUid}
                        mode="full"
                      />
                    </div>
                    <div className="flex items-center gap-2 text-xs truncate">
                      <span className="bx-hint truncate">Asset: {activeConv.listingTitle}</span>
                    </div>
                  </div>
                </div>
                {onReportConversation && (
                  <button
                    type="button"
                    onClick={() =>
                      onReportConversation({
                        reportedUserId:
                          activeConv.buyerId === userUid ? activeConv.sellerId : activeConv.buyerId,
                        reportedUserName:
                          activeConv.buyerId === userUid ? activeConv.sellerName : activeConv.buyerName,
                        surface: 'pre_deal_chat',
                        conversationId: activeConv.id,
                        listingId: activeConv.listingId,
                        listingTitle: activeConv.listingTitle,
                      })
                    }
                    aria-label="Report conversation participant"
                    className="bx-btn bx-btn-ghost px-3 py-1.5 text-xs font-extrabold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
                  >
                    <Flag className="w-3.5 h-3.5 text-rose-600 dark:text-rose-400" />
                    <span>Report</span>
                  </button>
                )}
              </div>

              {/* Mandatory First-Message Safety Notice */}
              {!hasAcceptedSafety ? (
                <div className="p-6 m-auto max-w-md space-y-4 text-center">
                  <div
                    className="p-4 rounded-2xl text-left space-y-2"
                    style={{ background: 'var(--yellow-soft)', color: '#5C4700' }}
                  >
                    <p className="text-xs font-extrabold uppercase flex items-center gap-1.5">
                      <ShieldAlert className="w-4 h-4" />
                      <span>Mandatory Marketplace Safety Notice</span>
                    </p>
                    <ul className="text-xs space-y-1.5 list-disc pl-4 font-semibold leading-relaxed">
                      <li>Never share passwords, OTPs, recovery codes, or authentication tokens in chat.</li>
                      <li>Never send payments outside BEXORA Escrow — off-platform transfers have zero protection.</li>
                      <li>Phone numbers, email addresses, and external contact links are automatically blocked.</li>
                    </ul>
                  </div>
                  <button
                    type="button"
                    onClick={handleAcknowledgeSafety}
                    className="bx-btn bx-btn-primary w-full"
                  >
                    I Understand — Continue to Chat
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex-1 p-4 space-y-3 overflow-y-auto max-h-[420px]">
                    {messages.length === 0 && (
                      <p className="bx-hint text-center py-8">
                        Ask questions about audience analytics or handover steps before placing a bid or buying.
                      </p>
                    )}
                    {messages.map((m) => {
                      const mine = m.senderId === userUid;
                      return (
                        <div
                          key={m.id}
                          className={`max-w-[82%] p-3 rounded-2xl text-sm space-y-1.5 ${
                            mine ? 'ml-auto' : 'mr-auto'
                          }`}
                          style={{
                            background: mine ? 'var(--orange)' : 'var(--surface-2)',
                            color: mine ? '#FFFFFF' : 'var(--text)',
                          }}
                        >
                          {m.kind === 'image' && sanitizeSafeImageSrc(m.mediaData) && (
                            <img
                              src={sanitizeSafeImageSrc(m.mediaData)}
                              alt="Chat attachment"
                              referrerPolicy="no-referrer"
                              className="rounded-xl max-h-52 object-cover"
                            />
                          )}
                          {m.kind === 'voice' && sanitizeSafeAudioSrc(m.mediaData) && (
                            <audio
                              controls
                              src={sanitizeSafeAudioSrc(m.mediaData)}
                              className="max-w-full h-9"
                            />
                          )}
                          {m.text && <p className="leading-relaxed break-words">{m.text}</p>}
                          <span className="block text-[10px] opacity-75 font-bold">
                            {new Date(m.createdAtMs).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  {isPausedForModeration && (
                    <div
                      className="mx-4 mb-2 p-3.5 rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-amber-950 dark:text-amber-100 text-xs space-y-1.5"
                      role="status"
                    >
                      <div className="flex items-center gap-1.5 font-extrabold">
                        <Lock className="w-3.5 h-3.5 shrink-0" />
                        <span>Safety Review Hold</span>
                      </div>
                      <p className="whitespace-pre-line leading-relaxed">{pauseNoticeText}</p>
                    </div>
                  )}

                  {warning && (
                    <div
                      className="mx-4 mb-2 p-2.5 rounded-xl text-xs font-bold"
                      style={{ background: 'var(--red-soft)', color: 'var(--red)' }}
                      role="alert"
                    >
                      {warning}
                    </div>
                  )}

                  <div
                    className="p-3 border-t flex items-center gap-2"
                    style={{ borderColor: 'var(--border-soft)' }}
                  >
                    <input
                      ref={imgInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      disabled={isPausedForModeration || sending}
                      onChange={(e) => handleImageAttachment(e.target.files)}
                      className="hidden"
                    />
                    <button
                      type="button"
                      disabled={isPausedForModeration || sending}
                      onClick={() => imgInputRef.current?.click()}
                      className="bx-icon-btn !w-10 !h-10"
                      aria-label="Send image message"
                      title="Send image"
                    >
                      <ImagePlus className="w-4 h-4" />
                    </button>

                    <button
                      type="button"
                      disabled={isPausedForModeration || sending}
                      onClick={toggleVoiceRecording}
                      className="bx-icon-btn !w-10 !h-10"
                      style={recording ? { background: 'var(--red)', color: '#fff' } : {}}
                      aria-label={recording ? 'Stop voice recording' : 'Record voice message'}
                      title={recording ? 'Stop recording' : 'Voice message'}
                    >
                      {recording ? <Square className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                    </button>

                    <input
                      type="text"
                      disabled={isPausedForModeration}
                      value={text}
                      onChange={(e) => {
                        setText(e.target.value);
                        setWarning('');
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && text.trim() && !sending && !isPausedForModeration) {
                          e.preventDefault();
                          sendPayload('text', text.trim());
                        }
                      }}
                      placeholder={
                        isPausedForModeration
                          ? 'Conversation paused pending administrator review…'
                          : 'Write a message…'
                      }
                      className="bx-input flex-1 !min-h-[40px]"
                    />

                    <button
                      type="button"
                      disabled={!text.trim() || sending || isPausedForModeration}
                      onClick={() => sendPayload('text', text.trim())}
                      className="bx-btn bx-btn-primary !min-h-[40px] !px-3.5"
                      aria-label="Send message"
                    >
                      <Send className="w-4 h-4" />
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
};
