#pragma once

#include <errno.h>
#include <stdint.h>

namespace voice_udp_policy {

enum class Stage : uint8_t {
  State = 0,
  Begin,
  Header,
  Payload,
  End,
};

enum class Action : uint8_t {
  Fail = 0,
  Retry,
  Reopen,
};

constexpr bool isSetupStage(Stage stage) {
  return stage == Stage::Begin || stage == Stage::Header ||
         stage == Stage::Payload;
}

constexpr bool isRetryableError(int error) {
  return error == EAGAIN || error == EWOULDBLOCK || error == EINTR ||
         error == ENOMEM
#ifdef ENOBUFS
         || error == ENOBUFS
#endif
      ;
}

constexpr bool isReopenableError(int error) {
  return error == EBADF
#ifdef ENOTSOCK
         || error == ENOTSOCK
#endif
      ;
}

constexpr Action decide(Stage stage, int error, bool reopened,
                        uint32_t elapsedMs, uint32_t timeoutMs) {
  return stage == Stage::State || elapsedMs >= timeoutMs
             ? Action::Fail
         : !reopened &&
                   (isSetupStage(stage) || isReopenableError(error))
             ? Action::Reopen
         : isRetryableError(error) ? Action::Retry
                                   : Action::Fail;
}

static_assert(decide(Stage::End, EAGAIN, false, 10, 400) == Action::Retry,
              "buffer pressure must retry the same datagram");
#ifdef ENOBUFS
static_assert(decide(Stage::End, ENOBUFS, false, 10, 400) == Action::Retry,
              "full lwIP buffers must be retried");
#endif
static_assert(decide(Stage::Begin, ENOMEM, false, 10, 400) == Action::Reopen,
              "the first staging failure must rebuild the socket");
static_assert(decide(Stage::End, EBADF, false, 10, 400) == Action::Reopen,
              "an invalid socket must be reopened once");
static_assert(decide(Stage::End, EAGAIN, false, 400, 400) == Action::Fail,
              "the retry deadline must remain bounded");
static_assert(decide(Stage::Begin, EIO, true, 10, 400) == Action::Fail,
              "a second nonretryable staging failure must fail the turn");
static_assert(decide(Stage::Begin, ENOMEM, true, 10, 400) == Action::Retry,
              "retryable pressure may continue after one reopen");
static_assert(decide(Stage::State, ENOTCONN, false, 0, 400) == Action::Fail,
              "a disconnected generation must never send");

}  // namespace voice_udp_policy
