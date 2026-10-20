/**
 * Jobs asynchrones pour les textes longs : progression en direct (SSE), annulation, expiration.
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');
const synth = require('./synth');

const TTL_MS = 60 * 60 * 1000;
const jobs = new Map();

function publicView(job) {
    return {
        id: job.id,
        status: job.status,             // queued | running | done | error | cancelled
        progress: job.progress,         // { done, total }
        createdAt: job.createdAt,
        finishedAt: job.finishedAt,
        error: job.error,
        result: job.result && {
            audioId: job.result.id,
            audioUrl: `/v1/audio/${job.result.id}`,
            subtitlesUrl: `/v1/audio/${job.result.id}/subtitles.vtt`,
            format: job.result.format,
            mimeType: job.result.mimeType,
            size: job.result.size,
            duration: job.result.duration,
            requests: job.result.requests,
            cached: job.result.cached,
        },
    };
}

function create(opts) {
    const job = {
        id: crypto.randomUUID(),
        status: 'queued',
        progress: { done: 0, total: synth.plan(opts).items.length },
        createdAt: new Date().toISOString(),
        events: new EventEmitter(),
        controller: new AbortController(),
    };
    job.events.setMaxListeners(50);
    jobs.set(job.id, job);

    const emit = () => job.events.emit('update', publicView(job));
    setImmediate(async () => {
        job.status = 'running'; emit();
        try {
            job.result = await synth.render(opts, {
                signal: job.controller.signal,
                onProgress: ({ done, total }) => { job.progress = { done, total }; emit(); },
            });
            job.status = 'done';
        } catch (err) {
            if (job.controller.signal.aborted) job.status = 'cancelled';
            else { job.status = 'error'; job.error = { code: err.code || 'internal_error', message: err.message }; }
        }
        job.finishedAt = new Date().toISOString();
        emit();
        setTimeout(() => jobs.delete(job.id), TTL_MS).unref();
    });
    return job;
}

const get = id => jobs.get(id);

function cancel(id) {
    const job = jobs.get(id);
    if (job && (job.status === 'queued' || job.status === 'running')) job.controller.abort(new Error('cancelled'));
    return job;
}

module.exports = { create, get, cancel, publicView };
