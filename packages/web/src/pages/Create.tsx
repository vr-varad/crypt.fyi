import { formatDistance } from "date-fns";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { motion, AnimatePresence } from "framer-motion";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { config } from "@/config";
import { encrypt, generateRandomString } from "@/lib/encryption";
import { Card } from "@/components/ui/card";
import { sleep } from "@/lib/sleep";
import {
  IconLock,
  IconCopy,
  IconEye,
  IconEyeOff,
  IconFlame,
  IconClock,
  IconQrcode,
  IconDownload,
} from "@tabler/icons-react";
import { sha256 } from "@/lib/hash";
import { useRef, useState } from "react";
import { clipboardCopy } from "@/lib/clipboardCopy";
import { QRCodeSVG } from "qrcode.react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const MINUTE = 1000 * 60;
const HOUR = MINUTE * 60;
const DAY = HOUR * 24;
const WEEK = DAY * 7;

const formSchema = z
  .object({
    c: z.string().default("").describe("encrypted content"),
    b: z.boolean().default(true).describe("burn after reading"),
    p: z.string().default("").describe("password").optional(),
    ttl: z
      .number({ coerce: true })
      .default(HOUR)
      .describe("time to live (TTL) in milliseconds"),
  })
  .superRefine((data, ctx) => {
    if (data.c.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["c"],
        message: "Content is required",
      });
    }
  });

const ttlOptions = [
  { label: "5 minutes", value: 5 * MINUTE },
  { label: "1 hour", value: HOUR },
  { label: "1 day", value: DAY },
  { label: "1 week", value: WEEK },
];

function svgToImage(svg: SVGElement): Promise<string> {
  return new Promise((resolve) => {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const img = new Image();
    const svgData = new XMLSerializer().serializeToString(svg);
    const svgBlob = new Blob([svgData], {
      type: "image/svg+xml;charset=utf-8",
    });
    const url = URL.createObjectURL(svgBlob);

    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      ctx?.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/png"));
    };

    img.src = url;
  });
}

export function CreatePage() {
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      c: "",
      p: "",
      b: true,
      ttl: HOUR,
    },
  });

  const createMutation = useMutation({
    mutationFn: async (input: z.infer<typeof formSchema>) => {
      await sleep(500, { enabled: config.IS_DEV });
      const key = await generateRandomString(20);
      let encrypted = await encrypt(input.c, key);
      if (input.p) {
        encrypted = await encrypt(encrypted, input.p);
      }
      const h = await sha256(key + (input.p ?? ""));

      const result = await fetch(`${config.API_URL}/vault`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          c: encrypted,
          h,
          b: input.b,
          ttl: input.ttl,
        }),
      });

      if (!result.ok) throw new Error("something went wrong");

      const data = await (result.json() as Promise<{
        id: string;
        dt: string;
      }>);
      const searchParams = new URLSearchParams();
      searchParams.set("key", key);
      if (input.p) {
        searchParams.set("p", "true");
      }
      const url = `${window.location.origin}/${data.id}?${searchParams.toString()}`;
      await clipboardCopy(url);
      toast.info("URL copied to clipboard");

      return {
        ...data,
        url,
        key,
      };
    },
    onError(error) {
      toast.error(error.message);
    },
  });

  async function onSubmit(data: z.infer<typeof formSchema>) {
    await createMutation.mutateAsync(data);
  }

  const { isSubmitSuccessful } = form.formState;
  const { reset } = form;

  const deleteMutation = useMutation({
    mutationFn: async (body: { id: string; dt: string }) => {
      await sleep(500, { enabled: config.IS_DEV });
      const result = await fetch(`${config.API_URL}/vault/${body.id}`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!result.ok) {
        if (result.status === 404) {
          setIsUrlMasked(true);
          reset();
          throw new Error("secret not found");
        }
        throw new Error(`unexpected status code ${result.status}`);
      }
    },
    onError(error) {
      toast.error(error.message);
    },
    onSuccess() {
      toast.success("Secret deleted");
      setIsUrlMasked(true);
      reset();
    },
  });

  const [isUrlMasked, setIsUrlMasked] = useState(true);
  let maskedUrl = createMutation.data?.url;
  if (isUrlMasked && createMutation.data?.url) {
    const url = new URL(createMutation.data.url);
    const searchParams = new URLSearchParams(url.search);
    const key = searchParams.get("key");

    if (key) {
      searchParams.set("key", "*".repeat(key.length));
    }

    maskedUrl = `${url.origin}/${"*".repeat(createMutation.data.id.length)}?${searchParams.toString()}`;
  }

  const [isQrDialogOpen, setIsQrDialogOpen] = useState(false);
  const qrCodeRef = useRef<SVGSVGElement>(null);

  const handleCopyQR = async () => {
    const svg = qrCodeRef.current;
    if (!svg) return;

    try {
      const dataUrl = await svgToImage(svg);
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      toast.success("QR code copied to clipboard");
    } catch (error) {
      toast.error(`Failed to copy QR code: ${error}`);
    }
  };

  const handleDownloadQR = async () => {
    const svg = qrCodeRef.current;
    if (!svg) return;

    try {
      const dataUrl = await svgToImage(svg);
      const link = document.createElement("a");
      const hash = await sha256(createMutation.data?.url ?? "");
      link.download = `phemvault-qr-${hash.slice(0, 8)}.png`;
      link.href = dataUrl;
      link.click();
      toast.success("QR code downloaded");
    } catch (error) {
      toast.error(`Failed to download QR code: ${error}`);
    }
  };

  return (
    <div className="max-w-xl mx-auto">
      <AnimatePresence mode="wait">
        {!isSubmitSuccessful ? (
          <motion.div
            key="form"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.3 }}
          >
            <Card className="p-4">
              <Form {...form}>
                <form
                  onSubmit={form.handleSubmit(onSubmit)}
                  className="space-y-4"
                >
                  <FormField
                    control={form.control}
                    name="c"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Secret content</FormLabel>
                        <FormControl>
                          <Textarea
                            {...field}
                            disabled={
                              createMutation.isPending || field.disabled
                            }
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="p"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Password</FormLabel>
                        <FormControl>
                          <Input
                            type="password"
                            placeholder="Optional (but recommended)"
                            {...field}
                            disabled={
                              createMutation.isPending || field.disabled
                            }
                          />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="ttl"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Time to live</FormLabel>
                        <FormControl>
                          <Select
                            onValueChange={(v) => {
                              field.onChange(Number(v));
                            }}
                            defaultValue={field.value?.toString()}
                            disabled={
                              createMutation.isPending || field.disabled
                            }
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select expiration time" />
                            </SelectTrigger>
                            <SelectContent>
                              {ttlOptions.map(({ label, value }) => (
                                <SelectItem
                                  key={value}
                                  value={value.toString()}
                                >
                                  {label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="b"
                    render={({ field: { value, onChange, ...rest } }) => (
                      <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4">
                        <FormControl>
                          <Checkbox
                            {...rest}
                            checked={value}
                            onCheckedChange={onChange}
                            disabled={createMutation.isPending || rest.disabled}
                          />
                        </FormControl>
                        <div className="space-y-1 leading-none">
                          <FormLabel>Burn after reading</FormLabel>
                          <FormDescription>
                            Guarantees only one recipient can access the secret
                          </FormDescription>
                        </div>
                      </FormItem>
                    )}
                  />
                  <div className="flex justify-end">
                    <Button type="submit" isLoading={createMutation.isPending}>
                      <IconLock />
                      Create
                    </Button>
                  </div>
                </form>
              </Form>
            </Card>
          </motion.div>
        ) : (
          <motion.div
            key="success"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.3 }}
          >
            <Card className="p-4">
              <div className="space-y-4">
                <div className="text-center mb-8">
                  <h2 className="text-xl font-bold mb-2">Secret Created!</h2>
                  <p className="text-muted-foreground text-sm mb-1">
                    Your secret has been created and the URL has been copied to
                    your clipboard
                  </p>
                  <p className="text-muted-foreground text-sm">
                    Share the URL{form.watch("p") && ` and password`} with the
                    desired recipient
                  </p>
                </div>

                <div className="flex items-center space-x-2 p-4 bg-muted rounded-lg">
                  <Input
                    type={isUrlMasked ? "password" : "text"}
                    value={isUrlMasked ? maskedUrl : createMutation.data?.url}
                    readOnly
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => setIsUrlMasked(!isUrlMasked)}
                  >
                    {isUrlMasked ? <IconEyeOff /> : <IconEye />}
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => {
                      if (createMutation.data?.url) {
                        clipboardCopy(createMutation.data.url);
                        toast.info("URL copied to clipboard");
                      }
                    }}
                  >
                    <IconCopy />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => setIsQrDialogOpen(true)}
                  >
                    <IconQrcode />
                  </Button>
                </div>

                <div className="flex justify-end flex-wrap gap-2">
                  <Button
                    variant="outline"
                    onClick={() => {
                      setIsUrlMasked(true);
                      reset();
                    }}
                  >
                    Create Another
                  </Button>
                  {createMutation.data && (
                    <Button
                      variant="destructive"
                      onClick={() => {
                        if (createMutation.data) {
                          deleteMutation.mutate({
                            id: createMutation.data.id,
                            dt: createMutation.data.dt,
                          });
                        }
                      }}
                      isLoading={deleteMutation.isPending}
                    >
                      Delete Secret
                    </Button>
                  )}
                </div>
                <div className="grid grid-cols-[auto_1fr] gap-2 text-xs">
                  <IconClock className="text-muted-foreground size-4" />
                  <p className="text-muted-foreground">
                    Expires in: {formatDistance(form.watch("ttl"), 0)}
                  </p>
                  {form.watch("b") && (
                    <>
                      <IconFlame className="text-muted-foreground size-4" />
                      <p className="text-muted-foreground">
                        Secret will be deleted after it is viewed
                      </p>
                    </>
                  )}
                  {form.watch("p") && (
                    <>
                      <IconLock className="text-muted-foreground size-4" />
                      <p className="text-muted-foreground">
                        Password protected
                      </p>
                    </>
                  )}
                </div>
              </div>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>
      <Dialog open={isQrDialogOpen} onOpenChange={setIsQrDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Secret URL QR Code</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col items-center space-y-4">
            <div className="qr-code p-4">
              {createMutation.data?.url && (
                <QRCodeSVG
                  ref={qrCodeRef}
                  value={createMutation.data.url}
                  size={256}
                  marginSize={4}
                  level="H"
                />
              )}
            </div>
            <div className="flex space-x-2">
              <Button variant="outline" onClick={handleCopyQR}>
                <IconCopy className="mr-2 size-4" />
                Copy QR
              </Button>
              <Button variant="outline" onClick={handleDownloadQR}>
                <IconDownload className="mr-2 size-4" />
                Download
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
