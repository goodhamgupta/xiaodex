// Xiaodex modification, 2026-08-26: flash-backed GBADoom saves use a
// CRC-protected sector journal so power loss cannot erase the last valid
// record and repeated saves are wear-levelled across the full partition.
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "esp_partition.h"
#include "doomport.h"

#define SRAM_SECTOR_SIZE 4096u
#define SRAM_SHADOW_SIZE 3072u
#define SRAM_RECORD_MAGIC 0x58444F4Du

typedef struct
{
    uint32_t magic;
    uint32_t sequence;
    uint32_t length;
    uint32_t crc32;
} sram_record_header_t;

static const esp_partition_t* s_part;
static unsigned char s_shadow[SRAM_SHADOW_SIZE];
static int s_activeRecord = -1;
static uint32_t s_sequence;

extern void I_Error(const char* error, ...);

static uint32_t crc32(const unsigned char* data, unsigned int length)
{
    uint32_t crc = 0xFFFFFFFFu;
    for (unsigned int i = 0; i < length; i++)
    {
        crc ^= data[i];
        for (int bit = 0; bit < 8; bit++)
            crc = (crc >> 1) ^ (0xEDB88320u & (uint32_t)-(int)(crc & 1));
    }
    return crc ^ 0xFFFFFFFFu;
}

static void checkEsp(esp_err_t result, const char* operation)
{
    if (result != ESP_OK)
        I_Error("SRAM %s failed (%d)", operation, (int)result);
}

static int recordCount(void)
{
    return s_part ? (int)(s_part->size / SRAM_SECTOR_SIZE) : 0;
}

static int loadRecord(int index, unsigned char* output, uint32_t* sequence)
{
    const size_t offset = (size_t)index * SRAM_SECTOR_SIZE;
    sram_record_header_t header;
    checkEsp(esp_partition_read(s_part, offset, &header, sizeof(header)), "header read");
    if (header.magic != SRAM_RECORD_MAGIC || header.length != SRAM_SHADOW_SIZE)
        return 0;

    checkEsp(esp_partition_read(s_part, offset + sizeof(header), output,
                                SRAM_SHADOW_SIZE), "payload read");
    if (crc32(output, SRAM_SHADOW_SIZE) != header.crc32)
        return 0;
    *sequence = header.sequence;
    return 1;
}

void SramInit(void)
{
    s_part = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, 0x40, "sram");
    if (!s_part)
        I_Error("SramInit: no 'sram' partition");
    if (recordCount() < 2)
        I_Error("SramInit: partition is too small");

    unsigned char* candidate = (unsigned char*)malloc(SRAM_SHADOW_SIZE);
    if (!candidate)
        I_Error("SramInit: no memory for journal scan");

    int found = 0;
    for (int index = 0; index < recordCount(); index++)
    {
        uint32_t sequence;
        if (!loadRecord(index, candidate, &sequence))
            continue;
        if (!found || (int32_t)(sequence - s_sequence) > 0)
        {
            memcpy(s_shadow, candidate, SRAM_SHADOW_SIZE);
            s_sequence = sequence;
            s_activeRecord = index;
            found = 1;
        }
    }
    free(candidate);

    if (!found)
        memset(s_shadow, 0, sizeof(s_shadow));
}

void SramRead(unsigned char* destination, unsigned int size, unsigned int offset)
{
    if (offset + size > SRAM_SHADOW_SIZE)
        I_Error("SramRead: out of range (%u+%u)", offset, size);
    memcpy(destination, s_shadow + offset, size);
}

void SramWrite(const unsigned char* source, unsigned int size, unsigned int offset)
{
    if (offset + size > SRAM_SHADOW_SIZE)
        I_Error("SramWrite: out of range (%u+%u)", offset, size);
    memcpy(s_shadow + offset, source, size);

    int target = (s_activeRecord + 1) % recordCount();
    size_t targetOffset = (size_t)target * SRAM_SECTOR_SIZE;
    sram_record_header_t header = {
        .magic = SRAM_RECORD_MAGIC,
        .sequence = s_sequence + 1,
        .length = SRAM_SHADOW_SIZE,
        .crc32 = crc32(s_shadow, SRAM_SHADOW_SIZE),
    };

    checkEsp(esp_partition_erase_range(s_part, targetOffset, SRAM_SECTOR_SIZE),
             "sector erase");
    // Payload first, validity header last. A reset between these writes leaves
    // the previous journal record valid and this target record ignorable.
    checkEsp(esp_partition_write(s_part, targetOffset + sizeof(header),
                                 s_shadow, SRAM_SHADOW_SIZE), "payload write");
    checkEsp(esp_partition_write(s_part, targetOffset, &header, sizeof(header)),
             "header write");

    s_activeRecord = target;
    s_sequence = header.sequence;
}
